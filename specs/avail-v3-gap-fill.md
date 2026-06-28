# avail-v3 gap fill (2026-06-19 → 2026-06-27)

Spec for `e` to fill the 10-day hole in avail-v3 canonical shards left
when the last `pyramid-cascade` run ended 2026-06-18 and before the
realtime CFW cascade started writing /1m partials 2026-06-28.

See `specs/done/pyramid-cascade-e-smoke.md` for the prior `e` invocation
template and `specs/avail-v3-cascade-cfw.md` for the realtime side of
the architecture.

## Background

Two writers feed avail-v3:

- **`e` pyramid-cascade** (this spec) — bulk-builds canonical
  `avail-v3/<tier>/<period>.parquet` for /1m..7d from raw 1m@1m R2
  inputs. Run periodically (currently ad-hoc).
- **CFW cascade** (`gbfs/cascade`) — writes /1m partials every /5m and
  promotes /1m partials → /1m canonical at midnight UTC. Runs
  continuously. Owns /1m for "today" + ongoing /1m canonical going
  forward.

Current D1 `pyramid_watermarks` (snapshot 2026-06-28T15:02Z, via
`scripts/pyramid-status.py avail`):

```
tier  cadence  watermark_end       notes
1m    (canon)  1970-01-01          empty — CFW will populate going fwd
1m    5min     2026-06-28 15:00    CFW partials, current
1m    10min   2026-06-28 15:00    CFW partials, current
1m    30min   2026-06-28 15:00    CFW partials, current
1m    1h      2026-06-28 15:00    CFW partials, current
2m    (canon)  2026-06-18         STALE — last cascade end
3m    (canon)  2026-06-18         STALE
5m    (canon)  2026-06-21         partial — some intermediate runs
10m   (canon)  2026-06-26         partial
15m   (canon)  2026-06-21         partial
30m   (canon)  2026-07-01         optimistic (shard 1mo); data only to 6/18
1h    (canon)  2026-07-01         optimistic; data only to 6/18
2h    (canon)  2026-07-01         optimistic; data only to 6/18
3h    (canon)  2026-07-01         optimistic; data only to 6/18
6h    (canon)  2027-01-01         optimistic (shard 1y); data only to 6/18
12h   (canon)  2027-01-01         optimistic; data only to 6/18
1d    (canon)  2027-01-01         optimistic; data only to 6/18
3d    (canon)  maxlong            optimistic (shard all); data only to 6/18
7d    (canon)  maxlong            optimistic; data only to 6/18
```

"Optimistic" means the watermark sits at the end of the **current
shard**, not the end of the **data**. The api worker therefore trusts
queries against those shards through their nominal end — but the actual
bins inside the shard stop at 6/18, so any query touching
[2026-06-19, 2026-06-28) returns empty on those tiers. This is what's
breaking "Latest · 7d" on StationDetail in prod (#111).

## Goal

After this run completes:

- Every canonical tier (/1m..7d) has data through **2026-06-27
  inclusive** (i.e. half-open through 2026-06-28).
- 2026-06-28 (today, in progress) is intentionally **excluded** —
  that's CFW's territory. Specifically, /1m canonical for 2026-06-28
  will be written by CFW's midnight promotion at 2026-06-29T00:00Z;
  /2m..7d for 2026-06-28 will land in the next periodic cascade run.

## Pre-flight (on `e`)

```bash
cd ~/c/hccs/ctbk
g f u && g rh u/main  # ensure HEAD matches the laptop-pushed main
spd                   # venv if needed
uv sync               # picks up any new ctbk deps

# verify raw 1m@1m inputs exist for the gap window (~1440 minutes/day)
for d in 2026-06-{19,20,21,22,23,24,25,26,27}; do
  n=$(aws s3 ls s3://ctbk/gbfs/avail/agg=1m/cons=1m/$d/ \
      --endpoint-url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --profile cf | wc -l)
  printf '%s: %d minutes\n' "$d" "$n"
done
```

Expect ~1440 per day. If any day is materially short, **stop and
report back** — gap-fill should not proceed against missing inputs.

## Cascade run

Half-open range `2026-06-19/2026-06-28` covers 9 days (6/19..6/27
inclusive). 6/28 is **excluded** so we don't overwrite anything CFW is
producing for today.

```bash
time ctbk pyramid-cascade \
  -c configs/pyramids/avail.yaml \
  -i avail \
  -r 2026-06-19/2026-06-28 \
  -E block \
  -j 9 \
  2>&1 | tee tmp/cascade-gap-fill.log
```

- `-E block` (chunked-block Polars + ProcessPool) is the benchmark
  winner — `specs/cascade-perf-comparison.md` measured Polars-chunked
  ≈2× faster than properly-parallelized Python-dict, on a 7-day range
  on `e`. `-E streaming` (single-process) is materially slower; only
  pick it if RAM is genuinely constrained (per-worker peak ~1.3 GB).
- 9-day range = 9 blocks with `task_size=1d` (default). `-j 9` is the
  max useful parallelism here; clamp to `e`'s core count if fewer.
- Wall target: ≤10 min on `e` (extrapolating from the smoke + perf
  measurements: 7 days at `-j 4` = 504s, so 9 days at `-j 9` should
  finish in ~5 min).

### What gets written

Cascade emits canonical shards across all derived tiers. Distinguish
two cases per tier:

**Day-multiple shards (2m..15m):** new daily shards land alongside
existing ones.
- /2m@2d: new 6/19, 6/21, 6/23, 6/25, 6/27 (5 shards)
- /3m@3d: new 6/19, 6/22, 6/25 (3 shards)
- /5m@5d, /10m@10d, /15m@15d: new shards covering 6/19..6/27 per their
  cadence
- /1m@1d: 9 new daily shards (6/19..6/27) — these fill the /1m
  canonical hole for the gap. CFW takes over for 6/28+.

**Month/year/all shards (30m..7d):** existing shards get **rewritten
in place** with the extended data.
- /30m..3h @ 1mo: the 2026-06 shard gets rewritten (extends from
  6/18 → 6/27 worth of data)
- /6h..1d @ 1y: the 2026 shard gets rewritten
- /3d, /7d @ all: the single all-time shard gets rewritten

These rewrites are byte-stable per the pinned pandas/pyarrow versions
(see comment in `pyproject.toml`). Re-running this same range on a
clean state should produce identical bytes.

### Manifest

The cascade writes `s3://ctbk/avail-v3/_manifest.json`. The api worker
uses D1 watermarks (not manifest) as source of truth, so the manifest
update is informational — but worth eyeballing post-run to confirm
shape:

```bash
aws s3 cp s3://ctbk/avail-v3/_manifest.json - \
  --endpoint-url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile cf | jq '.tiers | to_entries[] | {tier: .key, latest: .value.latest_period}'
```

Expect `2m.latest_period == "2026-06-27"`, `1h.latest_period ==
"2026-06"`, `1d.latest_period == "2026"`, etc.

## Post-cascade: update D1 watermarks (laptop)

After `e` reports done, on the laptop:

```bash
# Snapshot pre-state
scripts/pyramid-status.py avail | tee tmp/d1-pre.txt

# Advance day-multiple-shard tiers (their watermarks are stale, NOT
# optimistic). Set to 2026-06-28T00:00Z (= shard end of last filled
# shard).
TS=$(python -c 'from datetime import datetime, timezone; print(int(datetime(2026,6,28,tzinfo=timezone.utc).timestamp()*1000))')
NOW=$(python -c 'from datetime import datetime, timezone; print(int(datetime.now(timezone.utc).timestamp()*1000))')
for tier in 1m 2m 3m 5m 10m 15m; do
  npx wrangler d1 execute ctbk-gbfs --remote --command "
    UPDATE pyramid_watermarks
    SET latest_period_end = $TS, updated_at = $NOW
    WHERE pyramid = 'avail' AND tier = '$tier' AND cadence = ''
  "
done

# /30m..7d: watermarks are already optimistic (sit at shard end), so
# nothing to change. The shard rewrite makes the data agree with the
# (already-bumped) watermark.

# Verify
scripts/pyramid-status.py avail | tee tmp/d1-post.txt
diff tmp/d1-pre.txt tmp/d1-post.txt
```

If a watermark-update script gets reused (it will, for future periodic
runs), factor `scripts/pyramid-advance-watermarks.py <pyramid>
--through 2026-06-28` once we've done it twice.

## Verification

1. `scripts/pyramid-status.py avail` — confirm all canonical
   watermarks are at 2026-06-28T00:00Z or later.

2. CIC https://ctbk.dev/s/grove-st-path?availSrc=v3 — "Latest · 7d"
   window should now return non-empty data through ~6/27. The
   2026-06-28 tail is still served by CFW partials (already healthy
   per `pyramid_shards` 5min cadence).

3. Spot-check a tier shard against the planner:

```bash
# Read a single-cell slice from /1d 2026 shard, verify a 6/22-ish bin exists
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
aws --endpoint-url="$ENDPOINT" --profile cf s3 cp \
  s3://ctbk/avail-v3/1d/2026.parquet tmp/1d-2026.parquet
pqa tmp/1d-2026.parquet | head -30
```

## Flip StationDetail default

Once verified, re-flip the StationDetail default `availSrc` back to
`v3` (revert of 3e54ad08) and redeploy www. This is task #111.

## Caveats

- **Do NOT include 2026-06-28 in the range** — CFW is the writer for
  today. Including it risks racing with CFW's midnight promotion (CFW
  writes /1m canonical for 6/28 at 2026-06-29T00:00Z).
- **Don't run with the test-prefix** — this is a production fill, not
  a smoke. The smoke flow in `pyramid-cascade-e-smoke.md` is for shape
  verification only.
- **Concurrent /5m CFW ticks during the run are fine** — they only
  touch `/1m/p{cadence}/` paths, disjoint from the canonical
  `/1m..7d/<period>.parquet` paths cascade writes.

## Followups (separate spec)

The long-term decision (architecture A vs B in the conversation
thread): either schedule periodic `e` cron for ongoing /2m..7d
canonical refresh, or extend CFW to do cross-tier promotion locally.
Neither is in scope here.
