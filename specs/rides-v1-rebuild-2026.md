# Spec: rebuild `rides-v1` pyramid to include 2026 Q1+April

> Status: **draft** (2026-05-30). Single-machine task — should run on `e`
> while local continues `/v2` work. No code changes; just re-execution
> of `ctbk rides-v1-build` against the latest consolidated months.

## Why

`/v2` (the new homepage parity preview) loads from `/api/rides-v1`,
which reads the `rides-v1/<anchor>/<tier>/<period>.parquet` shards on
R2. Numerical parity against the static `ymrgtb_cd.json` ground truth
is **exact for years 2013–2025** (within 0.001%, rounding floor) but
**off by ~4M rides in 2026** — `static=10,007,276 vs api=6,078,008,
-39.3%`. The diff lines up to ~1 calendar month of current Citi Bike
volume.

Cause: the rides-v1 cascade was last built on `e` at `2026-05-28
07:18` (per R2 timestamps on `rides-v1/start/1y/2026.parquet` and
siblings). Between then and now, `0a73cf65 Process month 202604`
landed `s3/ctbk/normalized/202604.parquet.dvc`. The pyramid was built
from then-current consolidated months (probably 202601–202603) and
hasn't been rebuilt to include April.

Citi Bike has *not yet* published May 2026 tripdata (`s3://tripdata/`
tops out at `202604-citibike-tripdata.zip`, dated 2026-05-04). So
April is the entire achievable delta this pass.

## What to run

Pull, then rebuild the cascade for 2026 with `--overwrite` so the
year-sharded tiers (everything `1d`+) replace the stale shards and the
`1y` "all" shard reintegrates the full timeline:

```bash
git pull u main                              # picks up the spec + the
                                             # `8801b1c8` v2 commit;
                                             # nothing in the build code
                                             # changed.

# 1h tier — produces monthly shards from consolidated/normalized.
# Skip if you've kept this current; otherwise rebuild April:
ctbk rides-v1-build -a both -t 1h -f 202604 -T 202604 -O

# Cascade tiers — 2026 year-shard needs to be rewritten to include
# Q1+April. `--overwrite` is required since the shards already exist.
for t in 3h 6h 12h 1d 3d 7d 14d 1mo 3mo; do
  ctbk rides-v1-build -a both -t "$t" -f 202601 -T 202604 -O
done

# 1y tier — single `all` shard, always rebuilds from the full
# cross-year cascade. Pass -f/-T spanning all years:
ctbk rides-v1-build -a both -t 1y -f 201306 -T 202604 -O
```

Concurrency: the build supports `-c` (workers). Pick what `e` likes;
defaults (`-c 4`) have been fine.

## Verify

After the build, parity-check 2026 against the static
`ymrgtb_cd.json`:

```bash
ssh e -- "
  curl -sS 'https://ctbk-gbfs-api.ryan-0dc.workers.dev/api/rides-v1?anchor=start&from=2026-01-01T00:00:00Z&to=2026-05-01T00:00:00Z&bbox=40.5,-74.2,41.0,-73.7&reducer=sum&cell_budget=16&bin_budget=12' \
    | python -c 'import json,sys; d=json.load(sys.stdin); print(sum(r[\"count\"] for r in d[\"records\"]))'
"
# Expected: ~10,007,276 (matches static `ymrgtb_cd.json` for 2026).
```

If the number lands ≥ ~9.9M (allowing the same ~0.001% rounding floor
seen on 2013–2025), parity is met.

## Acceptance

- API total for 2026 within 0.01% of `ymrgtb_cd.json`'s 2026 total.
- `aws --profile cf s3 ls s3://ctbk/rides-v1/start/1y/all.parquet` and
  `…/start/1y/2026.parquet` both have fresh `LastModified`.
- A `/v2` page-load (locally or on prod once `8801b1c8` ships) shows
  bars through April 2026 close to the 4M-rides-per-month line, not
  the current ~3M cut-off.

## Out of scope

- **May 2026** tripdata — Citi Bike hasn't published it yet. Whenever
  it arrives (`ctbk import` will pick it up automatically via the
  daily `tripdata` cron), the cascade needs another rebuild for the
  affected 2026 shards. Consider folding rides-v1 into the existing
  `Process new month` CI pipeline so this becomes automatic. Tracked
  separately as a follow-up; not blocking.
- The small (+36k, +0.26%) discrepancy in 2016 — likely a lat/lng
  rounding edge at bbox boundaries (bbox includes 9 r5 cells; some
  fringe rides may map into a cell whose centroid sits outside the
  bbox). Worth a separate investigation if it ever turns into a UX
  issue; harmless for the parity-preview stage.

## After done

`mv specs/rides-v1-rebuild-2026.md specs/done/` and commit alongside
any output from the verify step.
