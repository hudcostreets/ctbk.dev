# avail-v3: R2 + D1 storage rename to uniform `{tier}/{shard_dur}/{period}` layout

Phase P5 of `specs/avail-v3-ladder-migration.md`. One-shot rename of
existing R2 keys + D1 inventory rows from the legacy
canonical/partial split layout to the unified shard-duration-keyed
layout defined in `~/c/pyrmts/specs/unified-shard-ladder.md`.

## Rename map

| Legacy R2 key | New R2 key |
|---|---|
| `avail-v3/<T>/<period>.parquet` (canonical) | `avail-v3/<T>/<largest_shard_dur>/<period>.parquet` |
| `avail-v3/<T>/p<dur>/<period>.parquet` (partial) | `avail-v3/<T>/<dur>/<period>.parquet` |

Where `<largest_shard_dur>` for each tier comes from the new
`avail.yaml`'s `tier.shards[-1]`:

```
/1m   → 1d
/2m   → 2d
/3m   → 3d
/5m   → 5d
/10m  → 10d
/15m  → 15d
/30m..3h → 1mo
/6h..1d  → 1y
/3d, /7d → 120y    (replaces legacy 'all'; see pyrmts spec)
```

D1 inventory: `pyramid_shards.cadence` column → `shard_dur`, populated
per the rename map (empty `cadence` → tier's largest).

## Implementation

Python script `scripts/avail-v3-rename.py` (uv-shebang). CLI:

```
avail-v3-rename.py [--dry-run] [--tier T] [--limit N]
```

Algorithm:

```python
import boto3
import polars as pl
from ctbk.pyramid_cascade.config import load_pyramid_config

config = load_pyramid_config('configs/pyramids/avail.yaml')
LARGEST_BY_TIER = {t.name: t.shards[-1] for t in config.tiers}

for tier in config.tiers:
    # 1. Legacy canonical: `avail-v3/<tier>/<period>.parquet`
    for obj in r2.list_objects(prefix=f'avail-v3/{tier.name}/'):
        # Skip sub-paths like avail-v3/<tier>/<dur>/ (already new layout, or partial)
        rel = obj.key.removeprefix(f'avail-v3/{tier.name}/')
        if '/' in rel:
            continue   # already in new layout or legacy partial — handled below
        # rel = '<period>.parquet'
        new_key = f'avail-v3/{tier.name}/{LARGEST_BY_TIER[tier.name]}/{rel}'
        rename(obj.key, new_key)

    # 2. Legacy partials: `avail-v3/<tier>/p<dur>/<period>.parquet`
    for cadence_prefix in r2.list_prefixes(prefix=f'avail-v3/{tier.name}/'):
        # cadence_prefix is e.g. 'avail-v3/1m/p1h/'
        name = cadence_prefix.removeprefix(f'avail-v3/{tier.name}/').rstrip('/')
        if not name.startswith('p'):
            continue   # already new (e.g. '1d', '5min')
        dur = name[1:]   # strip 'p'
        for obj in r2.list_objects(prefix=cadence_prefix):
            rel = obj.key.removeprefix(cadence_prefix)
            new_key = f'avail-v3/{tier.name}/{dur}/{rel}'
            rename(obj.key, new_key)
```

`rename(old, new)` uses R2 server-side `CopyObject` then
`DeleteObject` of the old. Idempotent: if `new` already exists with
the same ETag/size, skip the copy (don't delete the old yet — wait
for explicit `--force-delete-orphans` flag in a follow-up sweep).

**D1 inventory update:** after each successful R2 rename, upsert
`pyramid_shards` to the new shape. Use a transaction per ~100 rows.

```sql
-- Per (pyramid, tier, old_cadence, period):
UPDATE pyramid_shards
SET shard_dur = ?,
    key = ?
WHERE pyramid = ? AND tier = ? AND cadence = ? AND period_start = ?;
```

After all renames complete, also rename the column itself:

```sql
ALTER TABLE pyramid_shards RENAME COLUMN cadence TO shard_dur;
ALTER TABLE pyramid_watermarks RENAME COLUMN cadence TO shard_dur;
```

(P3's schema change can happen up-front if `cadence` is treated as a
free-text column; ALTER may need rebuilding the table — D1 caveat.)

## Pre-flight

```bash
# Snapshot pre-state — count shards by (tier, cadence) for diff
scripts/pyramid-status.py avail > tmp/d1-pre-rename.txt

aws s3 ls --recursive s3://ctbk/avail-v3/ \
  --endpoint-url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile cf | tee tmp/r2-pre-rename.txt | wc -l
# Record total shard count
```

## Run

```bash
# Dry-run first to verify the rename plan
scripts/avail-v3-rename.py --dry-run | tee tmp/rename-plan.txt
# Inspect — check counts per tier, sample paths

# Live run
scripts/avail-v3-rename.py 2>&1 | tee tmp/rename-live.txt
```

Wall estimate: ~500 R2 shards total at ctbk scale. R2 CopyObject is
~100ms each → ~1 min. D1 updates batch; ~few seconds.

## Post-flight

```bash
# Verify total shard count is preserved (no losses)
aws s3 ls --recursive s3://ctbk/avail-v3/ ... | wc -l
# Compare to pre-rename count

# Verify no orphan legacy paths
aws s3 ls --recursive s3://ctbk/avail-v3/ ... | grep -E '/p[0-9]+|avail-v3/[^/]+/[0-9]+-[0-9]+' | wc -l
# Expect 0 (no `p`-prefixed paths; no `<tier>/<period>` paths without shard_dur)

scripts/pyramid-status.py avail > tmp/d1-post-rename.txt
diff tmp/d1-pre-rename.txt tmp/d1-post-rename.txt
# Expect: cadence column renamed to shard_dur; empty cadence rows show <largest_dur>
```

## Cutover ordering

This phase MUST run AFTER P4 (CFW writer rewrite) deploys:
- P4 deploys new CFW writing to new paths.
- Then P5 renames legacy paths.
- During P5, R2 briefly has BOTH layouts (new from CFW + legacy
  un-renamed); planner reads both (during P6 transition). After P5
  + P6, only new layout remains.

Reverse order risks data loss: if rename happens before CFW rewrite,
the still-running OLD CFW writes to legacy paths the rename has
already moved → either over-creates orphans or loses fresh writes.

## Rollback

If P5 fails mid-run:
- Re-run with the same algorithm — idempotent (skips if new key
  exists).
- If catastrophic (e.g. D1 inventory diverges from R2 reality):
  rebuild `pyramid_shards` from a fresh R2 LIST, infer (tier,
  shard_dur, period) from each path.

If we need to revert to legacy layout entirely (unlikely): inverse
rename script (swap `dur` and `p<dur>` directions). Pre-rename R2
snapshot serves as recovery oracle.

## Cross-reference

- `specs/avail-v3-ladder-migration.md` — umbrella; P5 lives here.
- `~/c/pyrmts/specs/unified-shard-ladder.md` — defines the target
  layout.
