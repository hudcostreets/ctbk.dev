# Spec: h1 raw shards have 2407 rgs → CFW memory limit; reduce rg count

Status: **done** (2026-05-02). _Renamed/rewritten — first draft incorrectly
diagnosed missing stats; see Background._

## Background

After d25397ae was reverted (1102) and replaced by `4c34aa01` (range-read
parquet w/ `columnChunkAggregation`) + `398acc60` (pin hyparquet fork dist),
the worker `/api/totals` raw-tier path is **still failing** for any window
that hits the **h1 fallback** (current day, recent days before the GHA
daily compaction's /day raw bundle exists).

Repro (using `gbfs/api/ctbk-api`, added in `6ced98e9`):

```
$ cd gbfs/api
$ ./ctbk-api totals -S hoboken-terminal-hudson-st-hudson-pl \
    -f 2026-04-29T00:00:00Z -t 2026-04-30T00:00:00Z -b 5m -m all
HTTP 200  0.33s  165,378B  cache=MISS    # /day raw bundle (201 rgs)

$ ./ctbk-api totals -S hoboken-terminal-hudson-st-hudson-pl \
    -f 2026-05-01T00:00:00Z -t 2026-05-02T00:00:00Z -b 5m -m all
HTTP 503   9.50s   4,696B  cache=MISS    # h1 fallback (24 × 2407 rgs)
```

`wrangler tail` on the failing call shows:

```
GET .../api/totals?...&bin=300&filter.station_id=...
  - Exceeded Memory Limit
```

It is **memory**, not CPU — Workers have a 128 MB ceiling and the worker
is blowing it.

## Root cause: rg-count, not stats

(First-draft diagnosis was wrong: I read `pqm`'s `has_min_max: false` and
concluded h1 shards lacked stats. They actually do have stats — just
in the new Parquet 2.0 `min_value`/`max_value` fields, truncated to 16
chars per `hyparquet-writer/src/unconvert.js:153`. `pqm` (pyarrow) only
exposes the legacy `min`/`max` fields, hence the false negative.
hyparquet — what the worker uses — reads them fine.)

The actual problem: **the h1 compactor writes 2407 row groups per shard
(60 rows each)**. `gbfs/compactor/src/index.ts:181`:

```ts
return parquetWriteBuffer({ columnData, rowGroupSize: 60 });
```

The intent was: one rg ≈ one station × one hour ≈ ~5 KB of values, so
per-station queries decode just one rg. Data-wise this works (prune
matches 1/2407 rgs locally). But hyparquet parses the **entire footer**
eagerly, holding all 2407 rgs' column-chunk metadata in memory. With
~12 cols × ~24 shards in flight under `executeAvailTotalsQuery`'s
CONCURRENCY=6 + `getStationDay`'s parallel hours, the metadata pile
exceeds 128 MB.

This lesson was already encoded in `ctbk/avail_raw_day.py:95-98` (commit
`284182ba`):

> Tried `stations_per_rg=1` (≈1440 rows/rg per spec); regressed worker
> latency 7-13× because hyparquet parses the full footer eagerly and
> **rg-count dominates parse time on CFW**.

The Python /day raw and agg writers were updated to ~10 stations/rg
(~600 rows/rg → ~200 rgs/file) and work fine. The TS h1 compactor was
**not** updated to the same lesson, so it still emits 2407 rgs/shard.

## Fix

Change `gbfs/compactor/src/index.ts:181` to a much larger rowGroupSize.
Pick to match the /day raw bundle's profile (~200 rgs/file, ~14k rows/rg):

```ts
// h1 shard: 144000 rows / hour / ~2400 stations = ~60 rows/station/hour.
// At ~10 stations/rg (matching /day raw bundle layout), aim for ~600
// rows/rg → ~240 rgs/shard. Keeps station_id min/max stats useful for
// pruning while keeping footer size O(few hundred rgs) so the worker
// can parse 24 shards' metadata without exceeding 128 MB.
return parquetWriteBuffer({ columnData, rowGroupSize: 600 });
```

(Any value in `[600, 14000]` should work; lower bound preserves prune
selectivity, upper bound is "one rg per file" which would force full
decode.)

### Acceptance

- Newly-written h1 shards have ≤ ~250 row groups (vs. 2407 today).
- `station_id` `min_value`/`max_value` stats remain present per-rg
  (verify with hyparquet not pyarrow — the latter only shows legacy
  fields).
- After regenerating historical h1 shards, `./ctbk-api smoke -S
  hoboken-terminal-hudson-st-hudson-pl` shows OK and < 2s for **every**
  matrix cell — including the `1d × 5m (raw)` cell (h1 fallback) and
  the `7d × 5m (raw)` (mostly /day-raw, today via h1 stitch).

### Regen

Historical h1 shards live at `s3://ctbk/gbfs/avail/h1/<date>/<HH>.parquet`
(2026-04-20+). Either:
- Re-trigger the hourly compactor cron over the historical window, OR
- A one-shot `compactHour` driver script that iterates the date×hour
  matrix and overwrites each shard.

Idempotent: same key, same content modulo rg layout.

### Out of scope

- **Switching writers / forking `hyparquet-writer`.** First draft
  proposed this thinking stats were missing. They aren't; the writer
  is fine for our needs once rg-size is right.
- **Worker-side range-read of footer.** The reverted lesson in
  `avail_raw_day.py:95-98` mentions "until the worker switches to
  range-read metadata" as an alternative future. That's a hyparquet
  feature ask (`suffixStart`-style partial footer parse for huge files);
  out of scope here. Tuning rg-count solves it for our scale.
- **Going to 1 rg/file** (`rowGroupSize: 144000`). Disables station_id
  pruning entirely; `metric=all` would full-decode 144k rows × 5 cols
  per shard. Still small in absolute terms, but loses the pruning win
  the /day raw bundle relies on.

## Why this matters

Without this fix, the new `/api/totals`-only FE (`f0333dac` + `bf0c159a`,
local-only at present) cannot ship: any sub-hour avail chart that
includes today or yesterday's window will hit memory limit. Holding the
FE push on `h main` + `h main:www` until acceptance criteria are met.

## Done (2026-05-02)

Implemented in `85b03615` (`rowGroupSize: 60 → 600`). Verified shard at
`gbfs/avail/h1/2026-04-25/12.parquet`: **241 row groups** (was 2407),
600 rows/rg, `station_id` `min_value`/`max_value` stats present per-rg.

Historical h1 shards (2026-04-20 → 2026-05-02) regenerated via
`gbfs/regen-h1.sh` → `/compact?date=…&hour=…` (309/309 ok, 0 fail).
Endpoint also gated on `COMPACTOR_SECRET` header (`c5dbe27e`) to close
the trivial-DOS surface that the regen surfaced.

`./ctbk-api smoke -S hoboken-terminal-hudson-st-hudson-pl` (warm):
- h1 cells: **0.71-0.86s** (well under 2s) ✅
- raw cells: 2.06-3.41s (slightly over 2s) ⚠️ — driven by /day-raw
  bundle size (~12-18 MB × N days), not h1. Trivially fixable with
  `Cache-Control: public, s-maxage=…` on `/api/totals` responses for
  windows that don't include today; left as a separate follow-up.

OOM is fully resolved; FE push is no longer blocked on this spec.
