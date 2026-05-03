# Spec: availability /api/totals — performance pass

Status: **open** (2026-05-02).

## Goal

Cut perceived load time of the per-station availability chart on the
default view (7d-14d × auto-bin) so it lands in the same ballpark as the
trips chart and the map (both static-asset-fast). Keep the architecture
inside the existing multi-scale TS framework — **no per-station static
snapshots**, no side-channels.

After this pass, target latencies (cold edge cache, single-station,
`metric=all`):

| query                  | current | target |
|------------------------|---------|--------|
| 7d × 1h   (h1 tier)    | 0.55s   | 0.5s   |
| **7d × 30m  (raw → m15)**  | **3.29s**   | **0.6s**   |
| **7d × 15m  (raw → m15)**  | **3.17s**   | **0.6s**   |
| 7d × 5m   (raw)        | 3.17s   | 1.5s   |
| **14d × 30m (raw → m15)**  | **3.66s**   | **0.8s**   |
| 14d × 1h  (h1 tier)    | 0.86s   | 0.8s   |

Repeat-load latency target: **< 100 ms** (browser disk cache hit) for
any query whose `to` is in the past.

## Headliner: new `m15` pre-agg tier

The current `pickAvailAggTier` routes:

| bin range       | tier  | source                                          |
|-----------------|-------|-------------------------------------------------|
| `bin >= 1y`     | mo1   | `avail/agg/mo1/<decade>.parquet`                |
| `bin >= 30d`    | d1    | `avail/agg/d1/<ym>.parquet`                     |
| `bin >= 1h`     | h1    | `avail/agg/h1/<date>.parquet`                   |
| `bin <  1h`     | raw   | `gbfs/avail/raw/day/<date>.parquet` + h1 stitch |

Add an intermediate **`m15`** tier:

| bin range       | tier      | source                              |
|-----------------|-----------|-------------------------------------|
| `15m <= bin < 1h` | **m15** | `avail/agg/m15/<date>.parquet`     |

### File layout

Mirror **h1**'s two-level pattern so the in-progress day is also fast:

| layer            | key                                          | written by                  |
|------------------|----------------------------------------------|-----------------------------|
| per-hour shard   | `gbfs/avail/m15/<date>/<HH>.parquet`         | hourly cron (closes the hour) |
| daily cons       | `avail/agg/m15/<date>.parquet`               | daily cron (closes the day) |

- Per-hour shard: 4 buckets × ~3000 stations = ~12k rows/file. ~150 KB compressed.
  Written by the same per-hour compactor that builds `gbfs/avail/h1/<date>/<HH>.parquet`
  (one extra step, reusing the in-memory rows it already has).
- Daily cons: 96 buckets × ~3000 stations = ~288k rows/file. ~3 MB compressed.
  Written by the daily compactor by `concat`ing the day's 24 per-hour shards.
- Both: schema `{station_id, dt, bikes_mean, ebikes_mean, docks_avail_mean,
  docks_disabled_mean, pending_mean, sample_count}` (mirror `avail_agg.py`
  for h1/d1). Sorted `(station_id, dt)`, `_write_sorted_parquet` with
  `stations_per_rg=10` → station-pruned reads.

### Compactor

Two CLI subcommands paralleling the h1 split (`avail-h1` per-hour vs.
`avail-agg-h1` daily):

```
ctbk avail-m15 create <date>/<HH>          # build one closed hour
ctbk avail-agg-m15 create <date>           # cons 24 closed-hour shards into a daily file
```

Per-hour: read that hour's source rows (currently the WAL JSONs OR the
already-built `gbfs/avail/h1/<date>/<HH>.parquet`, whichever is the existing
input to `avail-h1`), group by `(station_id, floor(ts / 900) * 900)`,
write sorted.

Daily: simple `concat` of the day's 24 per-hour m15 shards. No per-row
recomputation needed — m15 is sum-monoid-aggregable so concat is correct.

GHA `gbfs-compact.yml` gains:
- An `m15-hour` step that runs alongside the existing per-hour `h1` step
  (in the same job; reuses the input read).
- An `m15-day` step that runs after the daily `avail-raw-day` step.

### Worker stitching

`resolveAvailTier` adds an `'m15'` case mirroring `'h1'`:

1. Try `avail/agg/m15/<date>.parquet` (daily cons) for each day in the window.
2. For the in-progress day (today), the daily cons is missing → fall back
   to per-hour shards `gbfs/avail/m15/<date>/<HH>.parquet` for closed
   hours.
3. For the current incomplete hour, fall back to the existing raw + WAL
   stitch (`stitchInProgressDay`) — same path h1 uses today. The 30m
   query reads ≤ 60 per-minute JSONs for one hour, same as today.

Net read pattern for D=7d B=30m today (vs. status quo):

| period            | today                                | with m15                                |
|-------------------|--------------------------------------|-----------------------------------------|
| 6 closed days     | 6 × `raw/day/<date>.parquet` (~5MB ea) | 6 × `agg/m15/<date>.parquet` (~3MB ea) |
| today closed hours | up to 23 × `avail/h1/<date>/<HH>.parquet` (~5MB ea, station-pruned) | up to 23 × `avail/m15/<date>/<HH>.parquet` (~150KB ea) |
| today current hour | up to 60 × `gbfs/status/<date>/<HH>-<MM>.json` | (unchanged) |

Decode time is dominated by the closed-hours shards on the in-progress
day — the m15 per-hour shards are ~30× smaller than the h1 raw ones, which
is where the bulk of the speedup comes from.

### Worker routing

`gbfs/api/src/totals.ts:pickAvailAggTier` adds the m15 branch:

```ts
if (binS >= 86400 * 365) return 'mo1';
if (binS >= 86400 * 30)  return 'd1';
if (binS >= 3600)        return 'h1';
if (binS >= 900)         return 'm15';   // NEW
return 'raw';
```

### Acceptance

- `gbfs/avail/m15/<date>/<HH>.parquet` shards present for all closed hours
  from h1's earliest date forward.
- `avail/agg/m15/<date>.parquet` daily cons present for all closed days.
- `gbfs/api/ctbk-api smoke -S hoboken-terminal-...` shows 7d/14d × 15m and
  7d/14d × 30m queries at < 1s (cold), including for windows that include
  the in-progress day.
- 7d × 5m (still raw) unchanged or improved.

## Quick wins (independent of m15)

These compose with the m15 work; ship in any order.

### 1. HTTP `Cache-Control` headers on closed-window responses

Worker `executeAvailTotalsQuery` currently caches via `caches.default`
(60s TTL) and emits no browser-cacheable headers. Add a header path:

```ts
const isClosedWindow = p.toS < (Date.now() / 1000) - 300; // 5min slack
const maxAge = isClosedWindow ? 86400 : 60;  // 24h vs 60s
resp.headers.set('Cache-Control', `public, max-age=${maxAge}, immutable`);
```

Effect: repeat loads (and panning into a previously-visited window) hit
browser disk cache → ~0 latency. Major UX win on revisit.

### 2. Strip `station_id` from rows when `filter.station_id` selects one station

When the query has exactly one station_id, the FE already knows it (it's
the URL slug). Stripping it from each row saves ~36 bytes × N. For 7d × 15m
× 5 metrics × 1 station = 3,360 rows: **~120 KB** saved (pre-gzip).

Implement on the worker side — drop `station_id` from each row when the
caller asks for a single station AND scope=stations. FE: tolerate missing
`station_id` and use the URL's known ID. Add a `station_id_implicit:
"<id>"` echo field at the response top level for safety.

### 3. Reshape `metric=all` from row-per-metric to wide row

Today `metric=all` returns:

```json
{ "rows": [
  {"dt": 1234, "station_id": "...", "metric": "bikes",         "sample_count": 30, "mean": 2.86},
  {"dt": 1234, "station_id": "...", "metric": "ebikes",        "sample_count": 30, "mean": 1.10},
  {"dt": 1234, "station_id": "...", "metric": "docks_avail",   "sample_count": 30, "mean": 19.04},
  {"dt": 1234, "station_id": "...", "metric": "docks_disabled","sample_count": 30, "mean": 0.0},
  {"dt": 1234, "station_id": "...", "metric": "pending",       "sample_count": 30, "mean": 1.0},
  ... ]}
```

5 rows per (dt, station). Flip to wide:

```json
{ "rows": [
  {"dt": 1234, "station_id": "...", "sample_count": 30,
   "bikes": 2.86, "ebikes": 1.10, "docks_avail": 19.04, "docks_disabled": 0.0, "pending": 1.0},
  ... ]}
```

1 row per (dt, station), inline metric values. **5× fewer rows**, ~3-5×
smaller pre-gzip; gzip narrows the gap but parse time still wins. FE
`totalsRowsToAvailabilityRows` already pivots row-per-metric → wide rows
internally, so the FE side is mostly a deletion.

This is a breaking response shape change. Behind a `?wide=1` flag for
one rollout cycle, then default-on; or a versioned response field
(`shape: "wide"`) the FE can branch on.

## Out of scope (rejected)

### Per-station static snapshot files

Tempting because it makes the default view *feel* free. Rejected because
it's a side-channel around the multi-scale TS API:

- Defaults shift (7d → 14d on mobile, 1h → 30m on desktop, etc.); the
  pre-baked file becomes a moving target.
- 3,000 files × (per-station, per-default-view, per-update-frequency)
  matrix grows unmanageably.
- Doesn't help anything *off* the default — pan/zoom/range-pick is still
  on the dynamic API, and feels suddenly slow by contrast.
- Worse: the multi-scale TS infra already covers this case; bypassing it
  splits the codebase's mental model.

The m15 tier + cache headers should land us inside the perceived-perf
budget. If they don't, revisit before introducing per-station snapshots.

## Implementation order

Independent enough to interleave; suggested sequence by ROI:

1. **Cache-Control header** (lines of code, big repeat-load win) — half a day.
2. **m15 tier** — 1-2 days; can land in two checkpoints:
   - 2a. Daily cons only (`avail/agg/m15/<date>.parquet`) + worker routing.
     Closed-day windows fast immediately; in-progress day still slow (falls
     through to raw + WAL stitch via existing path).
   - 2b. Per-hour shards (`gbfs/avail/m15/<date>/<HH>.parquet`) + worker
     stitch updated to read m15-hour shards for the in-progress day's
     closed hours. This is the change that makes "now-7d" queries fast.
3. **Reshape `metric=all`** (worker + FE pivot point) — half a day.
4. **`station_id` strip** (worker + FE fallback) — small, ship with #3.
