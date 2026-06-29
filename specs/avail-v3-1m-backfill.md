# avail-v3 `/1m` canonical backfill (2026-04-08 → 2026-06-28)

Backfill the missing `/1m@1d` canonical shards in `avail-v3/1m/` for
the entire history before today. Closes the largest tiling gap in the
avail-v3 pyramid (see `specs/avail-v3-1m-backfill.md` cross-ref to
`pyrmts/specs/unified-shard-ladder.md` for the broader POV).

## Background

`pyramid-cascade` (today) explicitly skips the base tier (`/1m`) per
the "1m base passthrough" section of `specs/pyramid-cascade.md` — the
design assumed the worker would read `/1m` queries directly from
`gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` (the raw 1m source).
That works for the **legacy** non-S2 avail path, but avail-v3 needs
S2-keyed + LUC-expanded `/1m` shards that don't exist today.

State of `avail-v3/1m/`:

- **Canonical (1d shards) at `avail-v3/1m/<date>.parquet`:** EMPTY for
  every date except possibly `2026-06-28` (written by the CFW midnight
  promotion at 2026-06-29T00:00Z, if that boundary's `/p12h` inputs
  existed — given the /p12h cron hadn't yet healed at that point,
  most likely also absent).
- **Partial sub-shards at `avail-v3/1m/p<cadence>/...`:** forward-
  rolling from CFW deploy 2026-06-27 15:35Z, with each cadence's
  earliest depending on its first-boundary-tick post-deploy.
- **Raw input at `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`:**
  intact back through ~2026-04-08 (verified during the 06-19→06-28
  recovery cascade).

The gap is real and was glossed over by relying on the FE Latest-7d
view picking up canonical /15m+ for the historical bulk. Any query
that needs /1m bins for past data — sub-day zoom, or once the planner
starts greedy-largest-shard-first walking per
`pyrmts/specs/unified-shard-ladder.md` — sees zero coverage.

## Goal

`ls s3://ctbk/avail-v3/1m/` shows one `<YYYY-MM-DD>.parquet` per day
in `[2026-04-08, 2026-06-28]` inclusive — 82 daily shards. Each
contains the LUC-expanded base data for that day, byte-stable per
pinned pandas/pyarrow.

`2026-06-29` (today, in progress) is INTENTIONALLY excluded — the CFW
midnight promotion will produce it at `2026-06-30T00:00Z` from /p12h
inputs.

## Impl

### Step 1: extend `pyramid-cascade` to optionally emit base tier

`ctbk/pyramid_cascade/{engine,engine_streaming}.py` both compute
`derived = [t for t in pyramid.tiers if t.name != base.name]` and
iterate only `derived` for shard emission. Replace with an opt-in
flag:

```python
# engine.py / engine_streaming.py — accept `include_base: bool = False`:
tiers_to_emit = pyramid.tiers if include_base else \
    [t for t in pyramid.tiers if t.name != base.name]
```

Source data is already in the long-form `(cell, dt, metric, state,
count)` shape after LUC expansion (`avail_ingester.py`). The base
tier's bin is 1min, so its per-row floor is a no-op; the per-(tier,
period) accumulator dedups by `(cell, dt, metric)` and produces the
same shape any derived tier does.

Add a CLI flag `--base / --include-base` to
`ctbk/pyramid_cascade/cli.py`:

```python
@option('-b', '--include-base', is_flag=True, help='Also emit the base
        tier (e.g. /1m) — default skips per the "1m base passthrough"
        convention in `specs/pyramid-cascade.md`.')
```

Pass through to engine functions.

Storage layout: `pyramid.keyTemplate` substitutes `{tier}` and
`{period}` — already produces `avail-v3/1m/<date>.parquet` for the
base tier. No path config change needed; the engine already routes
to `pyramid.storage.put(key, ...)`.

### Step 2: smoke

```bash
# 1-day slice, single-process, test prefix to avoid clobbering prod
sed 's|avail-v3/|avail-v3-base-smoke/|' configs/pyramids/avail.yaml \
  > tmp/avail-base-smoke.yaml

time ctbk pyramid-cascade \
  -c tmp/avail-base-smoke.yaml \
  -i avail \
  -r 2026-06-17/2026-06-18 \
  --include-base \
  -E block -j 1 -t 1d 2>&1 | tee tmp/cascade-base-smoke.log

# Verify
aws s3 ls s3://ctbk/avail-v3-base-smoke/1m/ \
  --endpoint-url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile cf
# Expect: 2026-06-17.parquet, ~30-100 MB (1440 bins × LUC-expanded cells)

# Probe shape
aws --endpoint-url="$ENDPOINT" --profile cf s3 cp \
  s3://ctbk/avail-v3-base-smoke/1m/2026-06-17.parquet tmp/1m-smoke.parquet
pqa tmp/1m-smoke.parquet | head -30
# Expect: dt range 2026-06-17T00:00:00Z → 23:59:00, cells include
# L10..L15 ancestors per station, metrics = bikes/ebikes/docks/disabled/pending
```

### Step 3: full historical backfill

After smoke passes:

```bash
# 82-day backfill, production prefix, full parallelism
time ctbk pyramid-cascade \
  -c configs/pyramids/avail.yaml \
  -i avail \
  -r 2026-04-08/2026-06-29 \
  --include-base \
  -E block -j 16 -t 1d \
  --partial-cover error \
  2>&1 | tee tmp/cascade-1m-backfill.log
```

- `-r ../2026-06-29` (half-open) writes 06-08..06-28 inclusive.
  06-29 is excluded — CFW writes today's /1m at tomorrow's midnight
  promotion.
- `--partial-cover error` (default per `e8d8ccdf`) ensures we don't
  re-overwrite /2m..7d (already in their correct state from the
  06-19→06-28 recovery cascade).
- `--include-base` is the only new flag.
- Expected wall: similar to the 06-08..06-28 recovery (~106 min for 82
  days; this run is the same scope but emits one additional tier).

### Step 4: validate

```bash
# Per-day count check
for d in 2026-{04,05,06}-{01..31}; do
  aws s3 ls s3://ctbk/avail-v3/1m/$d.parquet \
    --endpoint-url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --profile cf 2>/dev/null \
    && echo "  OK $d" || echo "  MISS $d"
done | grep -v 'MISS .*-(04-0[1-7]|06-29)' | head -100
# Expect: OK for every date in 2026-04-08 .. 2026-06-28.
```

### Step 5: update D1 watermarks

Once /1m canonical exists per day, the D1 `pyramid_watermarks` row
for `(pyramid='avail', tier='1m', cadence='')` should advance from the
epoch sentinel (`1970-01-01`) to `2026-06-29T00:00Z` (right edge of
the last filled day).

```bash
# On laptop (wrangler auth):
TS=$(python -c 'from datetime import datetime, timezone; print(int(datetime(2026,6,29,tzinfo=timezone.utc).timestamp()*1000))')
NOW=$(python -c 'from datetime import datetime, timezone; print(int(datetime.now(timezone.utc).timestamp()*1000))')
npx wrangler d1 execute ctbk-gbfs --remote --command "
  UPDATE pyramid_watermarks
  SET latest_period_end = $TS, updated_at = $NOW
  WHERE pyramid = 'avail' AND tier = '1m' AND cadence = ''
"
scripts/pyramid-status.py avail -t 1m
```

## After this lands

- The `availSrc=v3` flag can be safely defaulted to `v3` once the
  per-cadence walk-order bug self-heals (probably ~tomorrow, when
  /p3h's `earliestEntry` rolls past yesterday).
- `pyrmts/specs/unified-shard-ladder.md` becomes implementable —
  ctbk's avail-v3 will have complete /1m@1d canonical tiling
  + forward-rolling partials, and the planner refactor lands on a
  clean substrate.
- The CFW midnight promotion (already implemented in
  `gbfs/cascade/src/avail3/cascade.ts`) keeps /1m advancing one
  day per midnight; no further `e` runs needed for /1m unless we
  decide to also backfill smaller-duration shards (sub-day /1m) —
  out of scope for now.

## Risks

- **Byte-stability across `e` vs CFW promotions of /1m canonical.**
  CFW midnight promotion concats 2× `/1m@p12h` into the daily shard;
  `e` backfill goes raw → LUC → groupby → daily shard. The final
  bytes should be identical given byte-stable pinned deps + same
  sort + same RG size, but worth diffing the 06-28 shard CFW
  produced (if any) against an `e`-produced version of the same day,
  as part of step 2.
- **Storage cost.** 82 daily shards * (estimate) 50-100MB = 4-8 GB
  additional in `avail-v3/1m/`. R2 storage is cheap; bounded.
- **/2m..7d shards already correct.** Step 3's `--partial-cover
  error` guard prevents re-emit. If error fires, investigate before
  removing the guard.

## Cross-reference

- `specs/pyramid-cascade.md` §"1m base passthrough" — the convention
  this spec relaxes.
- `specs/avail-v3-cascade-cfw.md` — CFW continues writing /1m
  partials + midnight promotion; this backfill is independent.
- `pyrmts/specs/unified-shard-ladder.md` — broader unification this
  step enables.
- `specs/done/avail-v3-gap-fill.md` — prior 06-19..06-28 recovery
  cascade; same tooling, narrower scope.
