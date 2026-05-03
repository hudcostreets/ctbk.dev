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

`avail/agg/m15/<date>.parquet` — one file per UTC date.

- Schema: `{station_id, dt, bikes_mean, ebikes_mean, docks_avail_mean, docks_disabled_mean, pending_mean, sample_count}` (× whatever the agg fields are; mirror what `avail_agg.py` writes for h1/d1).
- One row per `(station, 15m bucket)` → 3,000 stations × 96 buckets/day = ~288k rows/file.
- Compressed size estimate: ~3 MB (h1 agg is ~3 MB at 24 bins/station/day; m15 has 4× more bins but doubles rather than multiplies once dictionary encoding kicks in).
- Sorted `(station_id, dt)`, `_write_sorted_parquet` with `stations_per_rg=10` → ~300 row groups, station-pruned reads.

### Compactor

New CLI subcommand mirroring `ctbk avail-agg`:

```
ctbk avail-agg-m15 create <date>          # build one closed day
ctbk avail-agg-m15 create -d 2026-04-01-2026-05-01  # range
```

Driven by reading the day's `gbfs/avail/raw/day/<date>.parquet`, grouping
by `(station_id, floor(ts / 900) * 900)`, computing means + sample_count,
sorting, writing.

In-progress day: do **not** write `m15` for today. Same fall-through as
the existing h1 tier — worker tries `m15`, gets 404, falls through to raw +
WAL stitch (already wired in `resolveAvailTier`).

GHA daily compaction (`gbfs-compact.yml`) gains an `m15` step alongside
the existing `raw-day`/`h1`/`d1`/`mo1` outputs.

### Worker routing

`gbfs/api/src/totals.ts:pickAvailAggTier` adds the m15 branch:

```ts
if (binS >= 86400 * 365) return 'mo1';
if (binS >= 86400 * 30)  return 'd1';
if (binS >= 3600)        return 'h1';
if (binS >= 900)         return 'm15';   // NEW
return 'raw';
```

`resolveAvailTier` adds the m15 case (parallel to h1: read agg parquet,
station-prune, sum into groups; on 404 for in-progress days fall through
to raw + WAL).

### Acceptance

- `m15` files present at `s3://ctbk/avail/agg/m15/<date>.parquet` for all
  closed days from h1's earliest date forward.
- `gbfs/api/ctbk-api smoke -S hoboken-terminal-...` shows 7d/14d × 15m and
  7d/14d × 30m queries at < 1s (cold).
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
2. **m15 tier** (Python compactor + worker resolver + GHA cron + regen) — 1-2 days.
3. **Reshape `metric=all`** (worker + FE pivot point) — half a day.
4. **`station_id` strip** (worker + FE fallback) — small, ship with #3.
