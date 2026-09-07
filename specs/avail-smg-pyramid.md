# SMG: station-minute state histograms (s2 × time pyramid)

Status: **proposed → building** (2026-09-06). Successor to the "OSM/SOSM" brainstorm; sibling of [`avail-v6`][v6-yaml] and complement to the [empty bitmaps][bitmaps]. **SMG** = station-minute histoGram: for a station set × time range, the histogram of `(station, UTC minute)` pairs over a small set of categorical *states*. (Not "SMH" — that's `station-meta-hist`, a trips pipeline stage.)

## Why

We want, at any scale in time *and* stations — one station, a `?sel=` group, a neighborhood, the whole system — cheap answers to "how much of the time is availability bad, and how?", drawn as:

- **L** (linear): outage station-minutes (or fraction) vs. time since genesis, bin chosen from span + viewport.
- **WH** (week-hours): rows = weeks, cols = 168 week-hours.
- **HH** (hour-of-day): x = hour of day (ET), y = Σ outage station-minutes, stacked by state.

All three are **sums** over `(station, minute)` cells of a categorical indicator — a monoid. That makes them a pyramid problem, and we already run exactly that machinery: [`avail-v6`][v6-yaml] is a histogram-monoid pyramid over `(s2_cell, dt)` built from the daily status parquets, served by `/api/avail-v3` with `reducer=hist`. SMG is its categorical sibling: **one `state` metric whose histogram over state ids *is* the per-state station-minute count.** Same ladder, cells, engine, registry, serving path. No whole-system special case: the homepage is the root cell / bbox read of the same pyramid that serves one `s:<short_name>` leaf.

The key trick vs. [`avail-outage-aggregations`][outage]: that spec concluded "classic-only" (`ebikes==0 ∧ bikes>0`) and the nullish reasons need a fine scan because they're joint across metrics. **Pre-classifying each `(station, minute)` into one categorical state at build time turns every such joint into a marginal of one metric** — monoidal, any tier, any window.

### What SMG can't do (and what still can)

Joint distributions *across stations at an instant* — "how many of my 5 stations were empty simultaneously" (k-of-K), runs/spans — are histograms of a sum and don't decompose over station sets. Those stay on the dense bitmaps via [`/api/empty`][bitmaps] (minute detail, `reduce=series` for the per-minute count, `window` for k-of-K). Both layers are derived from the same daily planes, in the same daily job.

(Aside on why the bitmaps aren't the general answer: R2/S3 don't support multi-range `Range` requests, so a scan is one GET per touched object — `days × shards` — and the coalescing trick that saves parquet reads (`RG_COALESCE_BYTES`, within one object) doesn't span objects. The bitmaps are fine for one station or a local group (1 shard); citywide history is a pyramid problem.)

## States

Every `(station, UTC wall-minute)` is in exactly **one** state; the partition sums to `#live-stations × 1440` per day. Precedence = first match, top to bottom. Measured 2026-08-15 (`tmp/smg_day_stats.py`, 2509 live stations, 1427 LU snapshots, 1440 heartbeats):

| id | state | rule | 2026-08-15 |
|---|---|---|---|
| 0 | `no_poll` | no cron heartbeat for the minute (`gbfs/heartbeat/<day>/HH-MM.txt` absent) — *our* gap | 0 (1440/1440 ticks) |
| 1 | `stale_feed` | heartbeat present, but no fresh `last_updated` snapshot landed in the minute — the feed's gap | 32,617 = 13 min × 2509 (0.90%) |
| 2 | `absent` | a fresh snapshot exists but this (live-that-day) station isn't in it | 0 (poller v2: every snapshot carries all 2509) |
| 3 | `offline` | present, but `is_installed==0` or `is_renting==0` (explicit GBFS; `is_renting ≡ is_returning`; these rows also carry `last_reported==0`) | 161,446 (4.47%) |
| 4 | `bogus` | installed & renting, but `bikes==0 ∧ docks==0` (unflagged dead station) | 877 (0.02%) |
| 5 | `empty` | `bikes==0` (docks>0) | 106,867 (2.96%) |
| 6 | `full` | `docks==0 ∧ ebikes>0` | 333,359 (9.23%) |
| 7 | `full_no_ebikes` | `docks==0 ∧ ebikes==0` (bikes>0) — return-side full *and* rent-side classic-only | 7,755 (0.21%) |
| 8 | `classic_only` | `bikes>0 ∧ ebikes==0 ∧ docks>0` | 311,971 (8.63%) |
| 9 | `ok` | `bikes>0 ∧ ebikes>0 ∧ docks>0` | 2,658,068 (73.57%) |

(Counts are station-minutes out of 2509 × 1440 = 3,612,960; `ctbk gbfs smg hist 2026-08-15`. `state_ff` moves the 32,617 stale minutes into the measured states pro rata.)

0–2 are **nullish** (no measurement), 3–4 are **measured-but-unusable**, 5–9 are the **usable measurements**. The usable five are the full rent-side × return-side grid — rent ∈ {empty, classic-only, ok} × return ∈ {full, not-full}, minus the impossible `empty ∧ full` (that's `bogus`) — so no bitmap condition is lost: `no_ebikes = empty + full_no_ebikes + classic_only`, `full = full + full_no_ebikes`. (A first cut folded `full_no_ebikes` into `full`; the bitmap identity check caught the 7,755 station-minutes it dropped.) Consumers fold as needed: "% empty" = `empty / Σ(5..9)`; "% no e-bikes" = `(empty + full_no_ebikes + classic_only) / Σ(5..9)`; "% of the time we couldn't tell" = `Σ(0..2) / total`; "% of listed stations offline" = `offline / Σ(3..9)`. 0 and 1 are system-wide (identical for every station in the minute) — stored per station anyway so the partition is complete and sums are trivial.

Not a state: `stale_station` (`last_reported` lagging the feed). Excluding offline rows, lag > 10 min is ≈0.03% of rows — not worth baking a threshold in. Revisit if it grows.

**Two metrics**, same partition:
- `state` — raw, as above.
- `state_ff` — nullish minutes (0–2) replaced by the station's last measured state (3–9) when one exists (within the day, seeded from the previous day's final state exactly as the bitmaps' `DayPlanes` carry); otherwise the raw nullish id. This is the "smooth line" variant (what the bitmaps' stored, forward-filled planes give); `state` is the honest one. Both are cheap (categorical hists), and having both means no consumer has to re-derive a fill.

Rows are **UTC wall-minutes** (`dt = floor(last_updated/60) × 60_000`, LU-attributed like v6). Local time / DST is the planner's and FE's problem, never the storage's.

## Data flow

```
gbfs/status/<day>.parquet ─┐
gbfs/heartbeat/<day>/*    ─┼─ ctbk gbfs empty build ──► gbfs/smg/<day>.parquet   (station_id, dt, state, state_ff)
prev-day final state      ─┘         (existing daily job; also writes the empty-v1p planes + coverage doc)
                                                              │
                                                              ▼
                              pyrmts-engine (Batch)  ─x ctbk_engine_src:smg_daily ──► smg-v1/{tier}/{shard}/{period}.parquet
                              SmgDailySource.parse → (s2_cell, dt, metric, state, count)   + D1 pyramid_shards registry
                                                              │
                                                              ▼
                              /api/avail-v3[/cells]?pyramid=smg-v1&reducer=hist&cells=…|bbox=…&from=&to=
```

### 1. Per-day source parquet (`gbfs/smg/<day>.parquet`)

Emitted by `ctbk gbfs empty build` (`ctbk/gbfs_empty.py`), which already has the day's dense grid, the vocab, the previous day's carry, and an R2 client. New inputs: the day's heartbeat listing (1440 tiny objects → one LIST) and the set of LU minutes (distinct `ts // 60`). New columns read from the status parquet: `is_returning`, `last_reported` (for stats only), plus the existing `is_installed`, `is_renting`, `num_*`. Roster for `absent` = stations seen ≥1 that day (the bitmaps' `live`).

Long form, one row per `(station, minute)`: `station_id: str`, `dt: int64 ms`, `state: int8`, `state_ff: int8`. ≈3.6M rows/day, gzip/zstd → a few MB (states are long runs). A `ctbk gbfs smg build <day>` / `backfill` also exists standalone so the 150-day history can be produced without re-running the bitmaps.

### 2. Engine source + pyramid config

- `ctbk/pyramid_cascade/smg_source.py`: `SmgDailySource(TiledSource)` — `tile_at` = one UTC day → `gbfs/smg/<day>.parquet`; `parse` → `unpivot(state, state_ff)` → join chains (`station_id → [ancestor s2 cells…, s:<short_name>]`, the frozen vocab expansion `avail_daily_status` already builds) → `group_by(s2_cell, dt, metric, state).count`. Same contract as `DailyStatusSource`.
- `gbfs/engine/ctbk_engine_src.py`: `smg_daily(pyramid, filter)` factory (chains built exactly as `avail_daily_status`). `gbfs/engine/Dockerfile`: `COPY ctbk/pyramid_cascade/smg_source.py /app/ctbk_smg_source.py`; rebuild/push the derived image (`pyrmts-engine batch push …`, header of the Dockerfile).
- `configs/pyramids/smg-v1.yaml`: clone of `avail-v6.yaml` with `key: "smg-v1/{tier}/{shard}/{period}.parquet"` and `metrics: [{state, histogram}, {state_ff, histogram}]`; identical tiers ladder (`1m … 7d`) and `geo.resolutions: [15..10]`.
- Backfill: `ctbk gbfs engine submit -C smg-v1 -x ctbk_engine_src:smg_daily -f` (Batch; declarative gap-fill, genesis → last compacted day). Runs off-laptop.

### 3. Serving

`gbfs/api/src/avail_geo.ts`: register `'smg-v1'` in `PYRAMIDS` (`vocab: true`). `METRICS` is currently module-global (`bikes…pending`) and baked into `makeBaseProps`; make it per-pyramid (`PYRAMIDS[name].metrics`) so `smg-v1` declares `['state', 'state_ff']`. Then the existing route serves it: `reducer=hist` returns per-bin `{ state: {"5": n_empty, "8": n_ok, …}, state_ff: {…} }`; the rollup route sums across the covering set (station-minutes per state — exactly SMG), `/cells` keeps per-station rows. No new route needed initially; a `/api/smg` alias with named-state keys can come later if the FE wants it.

### 4. Daily cadence

`gbfs-compact.yml` already runs `ctbk gbfs empty build` per day; that now also writes `gbfs/smg/<day>.parquet`. Add a following step: `ctbk gbfs engine submit -C smg-v1 -x ctbk_engine_src:smg_daily -f` (fills only the new day's rungs). Tip latency = one day, same as the source parquet. The Lambda tick's WAL `raw_fill` path is *not* wired for SMG in v1 (it would need the classifier + heartbeats in the Lambda); revisit if same-day currency matters.

### 5. FE

One component, three reshapes of `reducer=hist` rows — the selection is the only thing that differs between `/` (bbox = system), `/s/:slug` (`cells=s:<short_name>`), and `?sel=` (the set's cells):

- **L**: stacked area/bars of station-minutes (or fractions) per bin, states 5–8 as the denominator, 3–4 as a muted band, 0–2 as a gap band. Bin from span × viewport (the planner's `bin_budget`).
- **WH**: fetch the `1h` tier for N weeks, reshape to weeks × 168 (ET week-hours; DST weeks have a 167/169-col row — render as-is).
- **HH**: fetch `1h` (or `10m`) over the range, bucket by ET hour-of-day, stack by state.

Mark the 2026-08-04 poller-v2 boundary (pre-v2 `stale_feed` is inflated by the CloudFront-cached 1.1 feed). Reuse `useStationAvailability`'s TSQ shape (`www/src/query/stations.ts`) with `pyramid=smg-v1&reducer=hist`.

## Verification

Exact cross-checks against the bitmaps, same day, same station(s), via `/api/empty?reduce=series` (bin=day):

- bitmaps `observed` = `is_installed ∧ is_renting ∧ ¬(bikes==0 ∧ docks==0)` ⇒ **= SMG `Σ state∈{5..9}`**
- bitmaps `no_bikes` (strict) **= `empty`**; `full` **= `full + full_no_ebikes`**; `no_ebikes` **= `empty + full_no_ebikes + classic_only`**
- these run on every build (`smg_check`, raising on mismatch) — `ctbk gbfs smg build -k` / `empty build` — so the source parquet can't silently drift from the planes
- `state_ff` totals vs. the bitmaps' stored (forward-filled) planes: `no_bikes_ff = empty_ff`, etc.
- partition: `Σ all states = live × 1440` per day; `no_poll + stale_feed` minutes = `1440 − |LU minutes|`, split by heartbeat count.

Plus engine-vs-source parity the way v6 was validated (`ctbk gbfs engine build/compare` on a scratch prefix).

## Increments

1. **Source parquet**: classifier + `state_ff` + heartbeat/LU inputs in `gbfs_empty.py`; `ctbk gbfs smg build/backfill`; emit from `empty build`; backfill 150 days (on `e`/GHA). Cross-check vs `/api/empty` per the table above.
2. **Pyramid**: `SmgDailySource`, factory, Dockerfile, `smg-v1.yaml`, image push, Batch `-f` backfill; parity check.
3. **Serving**: per-pyramid metrics in `avail_geo.ts`; register `smg-v1`; verify `reducer=hist` end-to-end against the source parquet.
4. **FE**: `SmgChart` (L first, then WH/HH) on `/`, `/s/:slug`, `?sel=`.
5. **Cadence**: `gbfs-compact.yml` engine `-f` step; `/health` coverage of the new pyramid's tip.

## Storage / cost

Source parquet: ~3.6M rows/day but only **0.5 MB** zstd (station-major long runs; measured 2026-08-15) → ~180 MB/yr. Pyramid: same row scale as v6 (per-station identity leaves at `/1m`) with 2 small categorical hists instead of 5 wide ones — v6 already proves the engine + D1 budget at this scale. `/1m` per-cell tile reads for a year are small (categorical hist ≈ 9 ints/bin); the planner's coarser tiers handle multi-year L.

[v6-yaml]: ../configs/pyramids/avail-v6.yaml
[bitmaps]: ./avail-empty-bitmaps.md
[outage]: ./avail-outage-aggregations.md
