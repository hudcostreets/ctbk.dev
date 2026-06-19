# `e`: smoke + full pyramid-cascade rebuild

Spec for `e` to run `ctbk pyramid-cascade` against the new tool. See
`specs/pyramid-cascade.md` for the design.

## Pull + setup

```bash
cd ~/c/hccs/ctbk  # or wherever ctbk lives on e
git pull          # picks up the cascade build code
spd               # ensure venv is current
uv sync           # installs polars (new dep) and refreshes others
```

Pyrmts-py is already on `e/main` (per user); `pds l pyrmts pyrmts_geo`
if needed so ctbk on `e` consumes the local checkout.

## 1. Smoke: 1 day, 1 worker, verify shape

The avail ingester currently materializes ~10M Python dicts per
day-block before Polars takes over (streaming rewrite is in progress
on the laptop in parallel). Per day-block peak memory is ~10 GB; on
`e`'s big RAM this should be fine even at moderate parallelism.

Use a **test-prefix** config so we don't overwrite production
`avail-v3/` shards yet — verify shape first.

```bash
# Copy the YAML and rewrite the key prefix
sed 's|avail-v3/|avail-v3-test/|' configs/pyramids/avail.yaml > /tmp/avail-test.yaml

# Smoke: 1 day, 1 worker
time ctbk pyramid-cascade \
  -c /tmp/avail-test.yaml \
  -i avail \
  -r 2026-06-17/2026-06-18 \
  -j 1 \
  -t 1d \
  2>&1 | tee /tmp/cascade-smoke-1d.log
```

Expected:
- 1 block of work.
- Wall: hopefully <60s on `e` (24× the 24s-per-hour laptop measurement, so ~10 min worst-case, but vectorized Polars groupby should be much faster than the 24s linear extrapolation suggests).
- 14 outputs across 14 derived tiers. Partial vs full distribution depends on `task_size=1d`:
  - 2m@2d, 3m@3d, 5m@5d, ..., 15m@15d, all higher: **all partial** (block < shard size)
  - Or check `tail -30 /tmp/cascade-smoke-1d.log` for the per-tier "wrote partial/final" summary.
- Final stats line: `cascade: 1 block, X finals, Y partials → Z reduced finals, ... bytes, wall Ws`.

## 2. Smoke at parallelism: 1 week, 4 workers

```bash
time ctbk pyramid-cascade \
  -c /tmp/avail-test.yaml \
  -i avail \
  -r 2026-06-11/2026-06-18 \
  -j 4 \
  -t 1d \
  2>&1 | tee /tmp/cascade-smoke-1wk.log
```

Expected:
- 7 blocks, 4 workers active at peak.
- Memory: each worker ~10 GB; with 4 workers, ~40 GB peak. `e` should handle this.
- Wall: aim for <5 min total.
- Tiers: many partials → reduced to fewer finals (e.g. 7 partial `1h@1mo` → 1 reduced `1h@2026-06.parquet`).

## 3. Verify output shape

After (2), check the `avail-v3-test/_manifest.json`:

```bash
aws s3 cp s3://ctbk/avail-v3-test/_manifest.json - | jq .
```

Expected: a `tiers.{tier}.latest_period` entry per tier. Confirm:
- `2m`: `latest_period: "2026-06-16"` (day 6 of the 7-day window, since 6/17 → 6/18 produced partial)
- `1h`: `latest_period: "2026-06"` (the month containing all 7 days)
- `1d`: `latest_period: "2026"` (the year containing all 7 days)

Probe one rebuilt shard for shape (single-cell query latency, sanity check):

```bash
# Sample shard: 15m daily for 2026-06-15
aws s3 ls s3://ctbk/avail-v3-test/15m/2026-06-15.parquet --human-readable
# Expect: ~15 MB compressed, parquet
```

If everything looks right, **report the smoke result back to the
user**. Don't yet run the full historical rebuild — the next step
depends on how the user wants to proceed.

## 4. (Awaiting user direction) Full historical rebuild

After smoke + user confirmation:

```bash
# Production prefix (overwrite the existing avail-v3/ shards)
time ctbk pyramid-cascade \
  -c configs/pyramids/avail.yaml \
  -i avail \
  -r 2026-04-08/$(date -u -d 'yesterday' +%Y-%m-%d) \
  -j 16 \
  -t 1d \
  2>&1 | tee /tmp/cascade-full.log
```

Expected:
- ~71 blocks (April 8 → June 18-ish).
- Wall target: 10-30 minutes on `e` with `-j 16`.
- Storage: ~75 GB across all 14 derived tiers (production prefix).

After completing: report wall time + storage to user. The FE flip on
the worker side comes next (worker manifest read, then flipping
`availSrc=v3` default).

## Open question

The avail ingester memory profile may need attention before this scales
to multi-month / multi-year rebuilds (e.g. rides backfill, 13 years).
The streaming rewrite in progress on the laptop side will be a separate
commit; for now `e` runs against the current (memory-hungry) ingester
and uses RAM as the buffer.
