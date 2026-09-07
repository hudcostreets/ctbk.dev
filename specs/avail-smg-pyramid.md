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

**Heartbeat era**: `gbfs/heartbeat/` begins 2026-05-03 ~12:20 UTC. Before that, a minute with no LU snapshot has no heartbeat either, so it classifies as `no_poll` — there, id 0 means "unpolled *or* stale", and `stale_feed` is identically 0. Cross-era comparisons should fold 0+1 (`Σ nullish` is era-independent; the split is only meaningful from 2026-05-03). The backfill log confirms: `polled=0/1440` through 2026-05-02, `701/1440` on 05-03, `1440/1440` after.

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
- Stand-up (once per new prod pyramid, in this order; done 2026-09-07 from `e`):
  1. `ctbk gbfs engine config -C smg-v1 -R -u` — PUT the merged-ladder config at its **real** prefix (`r2://ctbk/smg-v1/config.yaml`). The engine reads the config from there, so without this the Batch job dies at startup with `config not found` (first attempt did exactly that).
  2. `pyrmts-engine batch push -c . -f gbfs/engine/Dockerfile -p linux/arm64 …/ctbk-engine:<sha>` then `ctbk gbfs engine jobdef …/ctbk-engine:<sha>` — the image must carry `ctbk_smg_source.py`, and `engine submit` always uses the latest `pyrmts-engine` job-definition revision (rev 12 = `f5fefbe1`).
  3. `ctbk gbfs engine submit -C smg-v1 -p smg-v1 -x ctbk_engine_src:smg_daily -f -W -w 1h -k 3 -c 2g -V 16 -M 49152` (`-p` = real prefix; the default is the `-engine-check` scratch prefix; the dials are avail-v5's proven full-backfill set). Declarative gap-fill, genesis → now. Two things the first attempts (on base image `pyrmts-engine:ed50cdb`) got wrong, both lifted by the 2026-09-07 base-image bump (increment 6):
     - **Memory budget.** The engine's default (70% of the cgroup limit) read the Fargate HOST's 66 GB inside the 32 GiB container and was OOM-killed (exit 137) at 96/307 × 12h windows; the resume ran with `-b 24g`. Since pyrmts `c594d6b` the *submitter* pins `-b` to 70% of the job memory (`-M`, else the job definition's) and the engine's own detection walks cgroup ancestors + ECS metadata and names its source in the banner — `-b` is optional again.
     - **Open periods.** `ed50cdb` predated open-period classification (pyrmts `72f2552`), so an uncapped fill wrote 0-row shards for the trailing rungs over not-yet-existing days and then failed the strict missing-source check; the first full build did exactly this (21 trailing shards over 09-06/09-07), and `ctbk gbfs engine sweep -C smg-v1 2026-09-06T00:00` removed them from R2 + D1 + manifest. `72f2552` alone was **not** enough: it only forgave the absence after the build, and an uncapped fill on a `72f2552`+ image still wrote 28 empty trailing shards (plus 3 inside avail-v6's live tip and 12 per rides-v5 anchor, all swept with the new `engine sweep -k KEY…`). pyrmts `22a5f32` makes fill mode *defer* every missing shard overlapping an absent open tile (`fill: N deferred (open-period source absent: …)`, exit 0, built by the next fill once the day's parquet lands). On that image `-r` needs no cap.
  4. Registration: `engine submit` does **not** write D1. `ctbk gbfs engine register -P smg-v1 s3://ctbk/smg-v1/manifest.jsonl` registered the 223 manifest shards; `ctbk gbfs engine adopt -C smg-v1` picked up the one shard the OOM'd job flushed but never recorded (`2m/4d/2026-04-13`, 11.9M rows — HEAD/md5 → manifest + D1). Steady state: the api worker's cron `reconcileRegistry` (`RECONCILE_PYRAMIDS` in `gbfs/api/src/index.ts`) now includes `smg-v1`, so each daily fill's new shards self-register (expected-cover ∩ R2 HEAD). D1 after stand-up: 224 `smg-v1` rows, cover [2026-04-07, 2026-09-06).

Prerequisite for step 3 (and for the daily step): every source day in the range exists, i.e. `ctbk gbfs smg backfill -k` has run (152 days 2026-04-07 → 2026-09-05 as of stand-up; ~8 s/day on `e`).

### 3. Serving

`gbfs/api/src/avail_geo.ts`: register `'smg-v1'` in `PYRAMIDS` (`vocab: true`). `METRICS` is currently module-global (`bikes…pending`) and baked into `makeBaseProps`; make it per-pyramid (`PYRAMIDS[name].metrics`) so `smg-v1` declares `['state', 'state_ff']`. Then the existing route serves it: `reducer=hist` returns per-bin `{ state: {"5": n_empty, "8": n_ok, …}, state_ff: {…} }`; the rollup route sums across the covering set (station-minutes per state — exactly SMG), `/cells` keeps per-station rows. No new route needed initially; a `/api/smg` alias with named-state keys can come later if the FE wants it.

### 4. Daily cadence

`gbfs-compact.yml` already runs `ctbk gbfs empty build` per day; that now also writes `gbfs/smg/<day>.parquet`. Two steps follow it:

1. `ctbk gbfs smg backfill -C -k -t <day>` — self-heal: builds any day that has a status parquet but no SMG parquet (a missed run; the days compacted before this step shipped). No-op when nothing is missing, so the fill never meets a real source hole.
2. `ctbk gbfs engine submit -C smg-v1 -p smg-v1 -x ctbk_engine_src:smg_daily -f -W -w 1h` — uncapped gap-fill, genesis → now (the base image classifies today's missing source as an open period; the submitter pins the memory budget — stand-up step 3). Fills only the rungs the new day completes; the worker's reconcile registers them. Until the 2026-09-07 image bump this step carried `-b 20g -r /<day+1>T00:00`.

Tip latency = one day + the GHA schedule lag (the `00:15 UTC` cron has actually fired at 04:20–04:35 UTC every day this week). The Lambda tick's WAL `raw_fill` path is *not* wired for SMG in v1 (it would need the classifier + heartbeats in the Lambda); revisit if same-day currency matters.

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

Engine-vs-source parity, checked end-to-end through the deployed worker on 2026-09-07 (`/api/avail-v3?pyramid=smg-v1&reducer=hist&bbox=40.5,-74.3,41.0,-73.6&from=2026-08-15&to=2026-08-16&bin_budget=1`, served from `smg-v1/1d/16d/2026-08-07.parquet`): every `state` bin equals the source-parquet table above **exactly** — 32,617 / 161,446 / 877 / 106,867 / 333,359 / 7,755 / 311,971 / 2,658,068, Σ = 3,612,960 = 2509 × 1440; `state_ff` Σ is the same 3,612,960 with bin 1 redistributed into 3–9. The `/cells` variant returns 12 level-10 cells whose bins sum to the same totals.

## Increments

1. ✅ **Source parquet**: classifier + `state_ff` + heartbeat/LU inputs in `gbfs_empty.py`; `ctbk gbfs smg build/backfill`; emit from `empty build`; 152 days backfilled on `e` 2026-09-07 (`-k`: every day's bitmap identities held).
2. ✅ **Pyramid**: `SmgDailySource`, factory, Dockerfile, `smg-v1.yaml`, image `ctbk-engine:f5fefbe1` (job-def rev 12), Batch `-f` backfill → 224 shards, cover [2026-04-07, 2026-09-06); swept/adopted per stand-up steps 3–4.
3. ✅ **Serving**: per-pyramid metrics in `avail_geo.ts`; `smg-v1` in `PYRAMIDS` + `RECONCILE_PYRAMIDS`; 224 rows registered in D1. End-to-end `reducer=hist` check against the source parquet: after the worker deploys.
4. ✅ **FE** (L view; WH/HH later): `www/src/query/smg.ts` (`useSmgHist`: one TSQ shape for `bbox` / `cells=s:…`; both partitions in one response, so forward-fill is a re-render) + `components/SmgChart.tsx` (uPlot stacked bands in `SMG_STATES` order, % or counts, legend solo/toggle, era markers for the 2026-05-03 heartbeat and 2026-08-04 poller-v2 boundaries, drag-pan) + `components/SmgPanel.tsx` (query + `sc`/`sff` toggles). Surfaces: `/` "Station states" section (system bbox, own `ar` window, default 30d), `/s/:slug` "Station state" under the availability chart (shares the page's `r` window and pan), `/stations?sel=…&rv=s` (the rides sheet's new rides/states toggle, shares `rr`). CIC'd 2026-09-07 on all three; a 12h system bin totals 2509 × 720 = 1.8M station-minutes as expected.
5. ✅ **Cadence**: `gbfs-compact.yml` self-heal + `-f` fill; `/health` lists `smg-v1` (`HEALTH_PYRAMIDS` in `gbfs/api/src/health.ts`) and `/api/files` browses `smg-v1/`.
6. ✅ **Base image bump** (2026-09-07): pyrmts `22a5f32` (= `72f2552` open periods + `specs/done/engine-fargate-mem-budget.md` + fill-mode deferral of shards over an absent open tile, addendum in `specs/done/engine-open-period-source.md`) → `pyrmts-engine:22a5f32` (arm64) → `ctbk-engine:<sha>` (job-def rev 14); ctbk's `pyproject.toml` pins re-locked to `22a5f32` so the GHA submitter defaults `-b`. Validation on the shared job definition: uncapped `smg-v1 -f` and `avail-v6 -f` defer the trailing rungs over today (nothing written, exit 0); rides-v5 `-f` capped at the last published month is a no-op. `gbfs-compact.yml`'s fill step dropped `-b 20g` and the `-r` cap.

## Storage / cost

Source parquet: ~3.6M rows/day but only **0.5 MB** zstd (station-major long runs; measured 2026-08-15) → ~180 MB/yr. Pyramid: same row scale as v6 (per-station identity leaves at `/1m`) with 2 small categorical hists instead of 5 wide ones — v6 already proves the engine + D1 budget at this scale. `/1m` per-cell tile reads for a year are small (categorical hist ≈ 9 ints/bin); the planner's coarser tiers handle multi-year L.

[v6-yaml]: ../configs/pyramids/avail-v6.yaml
[bitmaps]: ./avail-empty-bitmaps.md
[outage]: ./avail-outage-aggregations.md
