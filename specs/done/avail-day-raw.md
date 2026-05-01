# Spec: /day raw bundle tier for availability

Status: **done** (producer side, 2026-05-01). `ctbk avail-raw-day` ships
the daily compactor; backfill covers 2026-04-20 → 2026-04-30 (11 days);
GHA cron in `.github/workflows/gbfs-compact.yml` writes the new day
post-/h1 each morning. Worker reader path is tracked separately in
`specs/avail-unified-api.md`.

Companion to `specs/multiscale-timeseries-v2.md` Phase 3.

## Goal

Add a daily-bundle tier of per-minute raw availability data, sitting between
the existing `gbfs/avail/h1/` (hourly raw shards, current-day reads) and the
binned `gbfs/avail/agg/h1/` (hourly bins, monthly file post-resize).

This unlocks fast sub-hour-binned multi-day queries: a 7-day chart at /5min
bins drops from 168 hourly file reads to 7 daily file reads.

## File layout

```
gbfs/avail/raw/day/<YYYY-MM-DD>.parquet
```

Schema (matches existing `gbfs/avail/h1/<date>/<HH>.parquet`):

```
station_id           string   GBFS UUID
ts                   int64    poll timestamp (unix-s, minute-aligned)
polled_at            int64    actual poll wallclock
num_bikes_available  int16
num_ebikes_available int16
num_docks_available  int16
num_bikes_disabled   int16
num_docks_disabled   int16
is_installed         int8
is_renting           int8
is_returning         int8
last_reported        int64
```

Sort: `(station_id, ts)`.

Row group size: ~10 stations per rg (matches the avail-agg sort+rg pattern from
`ctbk/avail_agg.py` `_write_sorted_parquet()`). Each rg ≈ 10 × 1440 = 14400
rows.

Targeted file size: ~30-50 MB compressed (1500 stations × 1440 rows × ~25B/row
parquet-compressed).

## Compactor stage (Python)

New file: `ctbk/avail_raw_day.py` (or extend `ctbk/avail_agg.py` if cohesive).

```python
class AvailRawDay:
    NAMES = ['avail_raw_day', 'avr1d']

    def __init__(self, date: str):
        # date = YYYY-MM-DD
        self.date = date

    @property
    def url(self) -> str:
        return f'r2/ctbk/gbfs/avail/raw/day/{self.date}.parquet'

    def create(self, sync: bool = True):
        # 1. Sync gbfs/avail/h1/<date>/ from R2 if needed
        # 2. Read all 24 hourly shards into one DataFrame
        # 3. Dedupe by (station_id, ts) (matching avail_agg.py's pattern)
        # 4. Sort by (station_id, ts)
        # 5. Write parquet with row_group_size = ~10 stations × ~1440 rows
```

CLI:
```bash
ctbk avail-raw-day 2026-04-26
```

Re-use the `_write_sorted_parquet()` helper from `ctbk/avail_agg.py`
(extract to a shared module if it grows).

## Worker reader

Extend `gbfs/api/src/totals.ts` and `gbfs/api/src/index.ts`:

1. Add a new "tier" `dayRaw` to `AggTier` (or treat separately as a non-agg
   raw bundle).
2. Update `pickAvailAggTier()` so `binS < 1h && spanS > 24h` routes to
   `dayRaw`.
3. New key generator: `gbfs/avail/raw/day/<date>.parquet` for each day in
   the window.
4. New reader path that decodes the raw min schema (not histogram). Should
   apply the same row-group pruning by `station_id` (file is sorted by
   `(station_id, ts)`).
5. Aggregate into per-bin histogram on the fly so the response shape matches
   the existing `/api/totals?kind=availability` schema. Or: return raw rows
   and let the FE re-bin.

Decision: aggregate in CFW for response-size symmetry with the agg path.

## Routing

Updated `pickAvailAggTier(spanS, binS)` rules:

```
spanS ≤ 24h && binS < 1h    → /h1 raw + per-min JSONs (current path)
binS ≥ 1mo                   → /mo1
binS ≥ 1d                    → /d1
binS ≥ 1h                    → /h1 agg
binS < 1h && spanS > 24h     → /day raw (NEW)
```

## Lifecycle

- `/day raw` files are immutable once written (closed day).
- Existing `/h1 raw` shards stay for the in-progress day. Older /h1 raw
  shards can be GC'd post-/day-bundle (separate sweep job, not in this spec).

## Cron

Add to `.github/workflows/gbfs-compact.yml` after the existing
`compact-r2.py all` step:

```yaml
- name: Build /day raw bundle
  run: python3 -m ctbk.avail_raw_day ${{ steps.date.outputs.date }}
- name: Upload /day raw to R2
  run: aws s3 cp r2/ctbk/gbfs/avail/raw/day/${{ steps.date.outputs.date }}.parquet \
                 s3://ctbk/gbfs/avail/raw/day/${{ steps.date.outputs.date }}.parquet \
                 --endpoint-url $AWS_ENDPOINT_URL
```

## Backfill

One-shot batch: run `ctbk avail-raw-day` for each closed day from genesis
(2026-04-07) to yesterday. ~22 days at the time of writing.

## Acceptance

- [ ] `ctbk/avail_raw_day.py` builds local file, sorted + rg'd correctly
- [ ] Files for all closed days uploaded to R2
- [ ] Worker `/api/totals?kind=availability&bin=300&from=...&to=...` (5min bins
      over multi-day window) returns valid data, hits `/day raw` tier
- [ ] Cold path for 7d × 5min bin query: < 1s (target 300-500ms)
- [ ] Daily GHA cron writes `/day raw` for the new day automatically

## Notes

- This is the only new tier we plan to add beyond the existing
  raw-min/raw-hr/agg-{h1,d1,mo1} setup. After this lands, the avail
  pipeline matches the v2 spec's full Phase 1-3 scope.
- Trips-agg pipeline (separate spec) is independent — `e` may be mid-flight
  on it; this spec is orthogonal and won't conflict.
- Expected effort: ~2-4 hours including backfill.
