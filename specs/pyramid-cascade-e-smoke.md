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

Ingester is the **streaming Polars rewrite** (commit `e9673157`) — peak
RSS ~1.3 GB per day-block (measured 1h on laptop). On `e`, 4-worker
parallelism is comfortably ≤6 GB total; 16 workers ≤25 GB.

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
- Wall: laptop measurement was 21s for 1 hour single-process; extrapolated to 1 day at 24 hours is ~8 min worst-case, but most of that is R2 I/O (which on `e`'s direct-attached storage will be faster). Aim for <5 min.
- 14 outputs across 14 derived tiers. With `task_size=1d`:
  - `2m@2d, 3m@3d, 5m@5d, …, 15m@15d` and all higher: **all partial** (1d block < their shard size).
  - No fully-owned shards at 1d task_size for this pyramid; everything except `1m@1d` gets reduced.
  - Note: `1m@1d` is the base tier and is NOT written by pyramid-cascade — the existing `gbfs/avail/agg=1m/cons=1m/` hourly compactor still owns it. The worker reads from there for the /1m tier.
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
- Memory: each worker ~1.3 GB (per the streaming ingester measurement); 4 workers ≈ 5 GB peak.
- Wall: aim for <5 min total.
- Tiers: many partials → reduced to fewer finals (e.g. 7 partial `1h@1mo` → 1 reduced `1h@2026-06.parquet`).

## 3. Verify output shape

After (2), check the `avail-v3-test/_manifest.json`. **R2 endpoint
override required** — `aws s3` defaults to AWS S3, not Cloudflare R2:

```bash
# Use ~/.aws/credentials with a [cf] profile pointing at R2 endpoint, OR
# pass --endpoint-url inline:
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
aws --endpoint-url="$ENDPOINT" --profile cf s3 cp s3://ctbk/avail-v3-test/_manifest.json - | jq .
# (or use `rclone copy r2:ctbk/avail-v3-test/_manifest.json -` if rclone is configured)
```

Expected: a `tiers.{tier}.latest_period` entry per tier. Confirm:
- `2m`: `latest_period: "2026-06-16"` (day 6 of the 7-day window — 6/17 was the partial block-edge)
- `1h`: `latest_period: "2026-06"` (the month containing all 7 days)
- `1d`: `latest_period: "2026"` (the year containing all 7 days)

Probe one rebuilt shard for shape (single-cell query latency, sanity check):

```bash
aws --endpoint-url="$ENDPOINT" --profile cf s3 ls s3://ctbk/avail-v3-test/15m/2026-06-15.parquet --human-readable
# Expect: ~10-15 MB compressed
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
- Memory: ~21 GB peak (16 × 1.3 GB) — fits on any `e`-class node.
- Wall target: 10-30 minutes on `e` with `-j 16`.
- Storage: ~75 GB across all 14 derived tiers (production prefix).

After completing: report wall time + storage to user. The FE flip on
the worker side comes next (worker manifest read, then flipping
`availSrc=v3` default).

## Notes / followups

The current parallelism is bounded by **block count** (= range /
task_size). For a 7-day smoke at 1d task_size = 7 blocks max — `-j > 7`
buys nothing. For a 2-month full rebuild = ~60 blocks → `-j 32` gives
~2 blocks/worker, decent but not saturated. If we ever want true
linear scaling to 64+ cores, the parallelism model needs sub-block
work-units (parallel tier-emit per block, or smaller task_size).
For now, `-j` should match `min(block_count, cpu_count)`.
