# avail-v3: R2 + D1 storage rename to uniform `{tier}/{shard_dur}/{period}` layout

Phase P5 of `specs/avail-v3-ladder-migration.md`. One-shot rename of
existing R2 keys + D1 inventory rows from the legacy
canonical/partial split layout to the unified shard-duration-keyed
layout defined in `~/c/pyrmts/specs/unified-shard-ladder.md`.

**Unblocks deploy** of commit `fab241bb` (P0 + P2 — the api worker
reads from new paths; prod R2 still has the old layout, so a deploy
today would 404 every read).

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

D1 inventory: `pyramid_shards.cadence` rows where `cadence=''`
(legacy canonical sentinel) get populated to the tier's largest
shard. `key` column rewritten. **The column itself stays named
`cadence` here** — the SQL `ALTER COLUMN RENAME` is P3 (separate
phase), not P5. The api worker at commit `fab241bb` reads the
existing `cadence` column and translates at read time, so we can
cut over without coupling P5 to P3.

### Legacy `'all'` → `120y` period label

`<tier>/all.parquet` (for /3d, /7d in the prior model) maps to
`<tier>/120y/<period>.parquet`. `<period>` for a 120y shard needs a
real value. Two options:

- **(a) Fixed `1900`** (recommended): a 120y window starting 1900
  covers `[1900, 2020)` — pre-dates all real data, and any real query
  window will fall within `shard_periods_covering('120y', from, to)`
  → matches the `1900` shard. Renamed key:
  `avail-v3/3d/120y/1900.parquet`.
- **(b) Compute from data**: open the parquet, derive 120y window
  from `dt` min, label accordingly. More meaningful, costs a read
  per shard.

Going with (a). One-line decision, deterministic, no surprises.

## Implementation

Python script `scripts/avail-v3-rename.py` (uv-shebang). CLI:

```
avail-v3-rename.py [--dry-run] [--tier T] [--limit N]
```

Algorithm:

```python
import boto3
from pyrmts import parse_pyramid_yaml

cfg = parse_pyramid_yaml(open('configs/pyramids/avail.yaml').read())
LARGEST_BY_TIER = {t.name: t.shards[-1] for t in cfg.tiers}

for tier in cfg.tiers:
    # 1. Legacy canonical: `avail-v3/<tier>/<period>.parquet`
    for obj in r2.list_objects(prefix=f'avail-v3/{tier.name}/'):
        # Skip sub-paths like avail-v3/<tier>/<dur>/ (already new layout, or partial)
        rel = obj.key.removeprefix(f'avail-v3/{tier.name}/')
        if '/' in rel:
            continue   # already in new layout or legacy partial — handled below
        # rel = '<period>.parquet' — for /3d, /7d this is `all.parquet`; substitute.
        period = '1900.parquet' if rel == 'all.parquet' else rel
        new_key = f'avail-v3/{tier.name}/{LARGEST_BY_TIER[tier.name]}/{period}'
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

`rename(old, new)` uses R2 server-side `CopyObject` then optional
`DeleteObject` of the old. Two-pass mode recommended:

- Default: `CopyObject` to `new`, leave `old` in place. Idempotent
  (HEAD `new` first; skip copy if exists).
- `--delete-legacy` second pass (after smoke-testing the new
  deploy): DELETE everything matching the legacy patterns.

This makes the rename **reversible** until we explicitly run
`--delete-legacy`. Storage cost of keeping both for a day is
trivial (~$0.02/GB/mo).

**D1 inventory update:** after R2 rename(s) succeed, update
`pyramid_shards` + `pyramid_watermarks` in a single batch (via
`wrangler d1 execute --remote --file tmp/d1-rename.sql`):

```sql
-- Per tier: legacy canonical rows ('') → largest shard
UPDATE pyramid_watermarks
SET cadence = '<largest>'
WHERE pyramid='avail' AND tier='<tier>' AND cadence='';

UPDATE pyramid_shards
SET cadence = '<largest>',
    key = REPLACE(key, 'avail-v3/<tier>/', 'avail-v3/<tier>/<largest>/')
WHERE pyramid='avail' AND tier='<tier>' AND cadence='';

-- Per tier: legacy partial rows (cadence already set) → strip 'p' from key
UPDATE pyramid_shards
SET key = REPLACE(key, 'avail-v3/<tier>/p', 'avail-v3/<tier>/')
WHERE pyramid='avail' AND tier='<tier>' AND cadence!='';
```

(Generate the script by interpolating tier + largest-shard per tier
from the YAML.)

**P3 = column rename is separate.** This phase only updates row
values + the `key` column. The SQL `ALTER COLUMN RENAME cadence TO
shard_dur` is P3, and depends on us first deploying any code that
references `cadence` directly (`pyramid-status.py` does — it'd break
on the rename). Sequence: P5 → deploy api worker → P3 → update
ctbk-side raw-SQL consumers.

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

## Cutover ordering (zero-risk version)

The naive "rename then deploy" ordering opens two risk windows:
- After D1 `key` rewrite but before new-code deploy, the **deployed
  old api worker** uses `pyramid_shards.key` to `r2.get(key)`. If
  `key` now points at new R2 paths but R2 only has legacy paths,
  every read 404s.
- After R2 DELETE of legacy paths but before cascade redeploy, the
  **deployed old cascade** keeps writing to the legacy paths it just
  recreated — orphans that the new layout never indexes.

A 7-step ordering avoids both:

```
1. R2 COPY only (legacy → new, --no-delete --r2-only)   # additive; prod untouched
2. Verify new paths landed (sample HEADs, count)
3. Deploy NEW cascade  (gbfs/cascade — writes new paths only)
4. Deploy NEW api      (gbfs/api  — reads new paths only)
5. D1 row-value UPDATE (--d1-only)                       # only NEW api reads D1 now
6. Smoke-test prod (queries across 1d / 7d / 1mo / full-range)
7. R2 DELETE legacy paths (--delete-only)                # cleanup; risk-free post-(4)
```

Why each gap is safe:

- **(1) → (2) → (3)**: legacy R2 untouched, D1 unchanged. Old api +
  old cascade run with no observable difference. New paths exist
  but no one references them yet.
- **(3) → (4)**: new cascade writes only new paths; old api keeps
  reading legacy paths (still present). New-path writes invisible
  but harmless.
- **(4) → (5)**: new api reads legacy keys from D1 (still
  `cadence=''`). The new-api translation in `loadEarliestPerShard`
  maps `cadence='' → ${tier}@${largestPerTier[tier]}` at read time,
  so it works against legacy D1 state too. The R2 path resolution
  happens via pyrmts's planner — which uses keyTemplate substitution,
  not `pyramid_shards.key`. (Verify: pyrmts JS doesn't read `.key`
  for fetch; that column is informational. If it does, swap step
  ordering: D1 update before api deploy, after rename.)
- **(5) → (6)**: D1 update changes `cadence=''` → `cadence='<largest>'`
  and rewrites `key`. New api was already independent of D1 `key`
  column; D1 cadence-key update brings the map shape to new uniform
  form. Smoke-test confirms.
- **(7)**: prod is now entirely on new layout; legacy R2 is dead
  weight. Delete is purely a cleanup pass.

### Caveat: does the deployed pyrmts use `pyramid_shards.key`?

Verify before running step 5: grep `gbfs/api`'s deployed `avail_geo.ts`
+ the deployed pyrmts source for `pyramid_shards.key` reads. If
nothing reads it (likely — pyrmts's planner does key-template
substitution from `(tier, shard, period)`, the `.key` column is just
audit data written by `D1ShardIndex.recordShard`), the ordering above
holds and D1 update can come after api deploy.

If something does read it (e.g. a `D1ShardIndex` lookup uses
`.key` to fetch the parquet directly), the ordering changes: D1
update must precede api deploy, and the window between D1 update
and api deploy is unsafe (deployed old api would look up new keys
against old R2 if R2 DELETE somehow precedes — but step 7 is the
only delete). Net: even in that case, the only unsafe sub-window is
"D1 updated but new api not yet live", which is minutes. Plan
accordingly.

## Rollback

If P5 fails mid-run:
- Re-run — idempotent (HEAD-skip if new key already exists).
- If catastrophic (e.g. D1 inventory diverges from R2 reality):
  rebuild `pyramid_shards` from a fresh R2 LIST, infer (tier,
  shard_dur, period) from each path.

If the new api worker has a regression we want to roll back the
*deploy* (not the rename), the two-pass `--no-delete` mode keeps
legacy R2 objects intact:
- Re-deploy old api worker (reads legacy paths).
- D1 stays at new shape — old worker reads `cadence=''` as before
  (its translation logic still works), but `cadence='1d'` rows look
  like partials it doesn't know about. So the D1 update *is* part of
  what would need rolling back — restore from the pre-rename D1
  snapshot.

Hard revert (unlikely): inverse rename script. Pre-rename R2 +
D1 snapshots in `tmp/` serve as recovery oracles.

## Cross-reference

- `specs/avail-v3-ladder-migration.md` — umbrella; P5 lives here.
- `~/c/pyrmts/specs/unified-shard-ladder.md` — defines the target
  layout.
