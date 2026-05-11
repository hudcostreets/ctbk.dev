# Spec: R2 storage layout cleanup (`gbfs/` vs `avail/`)

> Status: **draft** (2026-05-10). Settles the destination layout that the
> GBFS health page (`specs/gbfs-health-page.md`, forthcoming) targets.
> Physical migration sequenced last, after the health page lands.

## Problem

Derived GBFS-availability data is currently split across two top-level
prefixes (`gbfs/avail/...` and `avail/...`) with three+ generations of
naming overlapping each other. The split has no organizing principle —
it's an accumulation of layers added over time.

Surfaced when the file browser (`/files/*`) showed `avail/` and `gbfs/`
as siblings: "isn't it all GBFS data (or derived from it)?" Yes. The
layout fails the "principle of least surprise" test.

## Current state

```
gbfs/                                                     ← raw + early compactions
├── status/<date>/<HH-MM>.json                            n0 — raw minute poll      [cron worker writes]
├── status/<date>.parquet                                 daily WAL bundle          [compact-r2.py writes]
├── stations/<uuid>/<yyyymm>.parquet                      per-station month slice   [compact-r2.py slice writes]
├── info/<date>.json                                      daily station info        [cron worker writes]
├── heartbeat/...                                         cron heartbeat            [cron worker writes]
└── avail/                                                ← derived: misplaced here, should be under avail/
    ├── raw/day/<date>.parquet                            d0 — raw daily bundle     [compact-r2.py writes]
    └── h1/<date>/<HH>.parquet                            h1 — hourly aggregate     [compactor CFW writes]

avail/                                                    ← derived availability rollups
├── agg/                                                  ← legacy daily-flat
│   ├── h1/<date>.parquet                                 hourly agg, file-per-day  [legacy]
│   ├── d1/<yyyymm>.parquet                               daily agg, file-per-month [legacy]
│   └── mo1/<year>.parquet                                monthly agg, file-per-year [legacy]
└── agg=<A>/cons=<C>/<period>.parquet                     multi-scale grid (Hive)   [cascade CFW + loader write]
```

Three generations of derived layouts:
1. **`gen-1` daily-flat** (`avail/agg/{h1,d1,mo1}/`) — earliest, mirrored from the trips-pipeline naming
2. **`gen-2` hive-style hourly** (`gbfs/avail/h1/`) — compactor CFW output (under `gbfs/`, not `avail/`)
3. **`gen-3` hive-style multi-scale** (`avail/agg=A/cons=C/`) — current cascade pyramid

Plus a raw daily bundle (`gbfs/avail/raw/day/`) sitting on its own under `gbfs/avail/`.

### Readers (blast radius of any path change)

| Path | Reader |
|------|--------|
| `gbfs/status/<date>/<HH-MM>.json` | loader CFW (R2 event consumer), daily compactor, api worker (`readMinuteJsonsForHour`) |
| `gbfs/status/<date>.parquet` | compactor downstream phases |
| `gbfs/stations/<uuid>/<yyyymm>.parquet` | api worker `getStationMonthFromR2` |
| `gbfs/info/<date>.json` | `load_gbfs_info.py` |
| `gbfs/avail/raw/day/<date>.parquet` | api worker `totals.ts:rawDayKey` |
| `gbfs/avail/h1/<date>/<HH>.parquet` | api worker `index.ts:117,896`, `ctbk/avail_agg.py` |
| `avail/agg/h1/<date>.parquet` | api `totals.ts:317` |
| `avail/agg/d1/<yyyymm>.parquet` | api `totals.ts:316` |
| `avail/agg/mo1/<year>.parquet` | api `totals.ts:315` |
| `avail/agg=A/cons=C/<period>.parquet` | api `planQuery.ts` (the multi-scale path) |

## End state

One root for derived availability data. Raw + per-station-month stays
under `gbfs/` since it's a 1:1 mirror of the upstream feed.

```
gbfs/                                                     ← raw GBFS feed mirror, unchanged
├── status/<date>/<HH-MM>.json
├── status/<date>.parquet
├── stations/<uuid>/<yyyymm>.parquet
├── info/<date>.json
└── heartbeat/...

avail/                                                    ← all derived availability data
├── raw/day/<date>.parquet                                ← moved from gbfs/avail/raw/day/
├── h1/<date>/<HH>.parquet                                ← moved from gbfs/avail/h1/  (gen-2)
├── agg/{h1,d1,mo1}/...                                   ← gen-1 legacy: retire if unused, else move under avail/
└── agg=<A>/cons=<C>/<period>.parquet                     ← gen-3 (current cascade)
```

This makes the file-browser virtual root cleaner: top-level is
`gbfs/` (raw upstream) and `avail/` (analytical product), with no
deep-derived data hiding under `gbfs/avail/`.

The `avail/agg=*/cons=*/` cascade is the long-term target format. The
legacy `gen-1` daily-flat dirs (`avail/agg/{h1,d1,mo1}/`) should be
retired once the cascade covers their consumers — the planner already
selects from the cascade for `/api/query`; `/api/totals` still routes
through them.

## Migration

Each rename is two-step: dual-write → reader cut-over → drop old. Renames
are reversible until the drop step.

### Phase 1 — Cleanup `gbfs/avail/` (move derived data out of the raw prefix)

#### Step 1a: `gbfs/avail/h1/` → `avail/h1/`
1. Compactor CFW: write to both keys (≤6 LOC change). One cron tick.
2. Reader cut-over:
   - `gbfs/api/src/index.ts:117,896` — switch to new key (api reads `avail/h1/...`).
   - `ctbk/avail_agg.py` — switch to new key.
3. Copy historical `gbfs/avail/h1/*` → `avail/h1/*` via `aws s3 cp --recursive` (one-shot).
4. Verify api reads from new path for both today + historical.
5. Stop the dual write; drop old path.

Blast radius: 1 worker write site, 2 reader sites, 18 days of historical
data (~432 files × ~1 MB each ≈ 450 MB).

#### Step 1b: `gbfs/avail/raw/day/` → `avail/raw/day/`
Same pattern, single writer (compact-r2.py), single reader
(`totals.ts:rawDayKey`).

### Phase 2 — Legacy daily-flat retirement decision

Three options for `avail/agg/{h1,d1,mo1}/`:

A. **Retire entirely**. `/api/totals` switches to cascade-pyramid reads for
   the same query. Test parity first; once equivalent, stop writing
   `gen-1`. Drop the historical data after a grace window.

B. **Move under `avail/legacy/` and freeze**. Acknowledges the format
   exists but signals "don't add more." Simpler than A but keeps two code
   paths.

C. **Leave alone**. Lowest risk, highest mess.

Recommendation: A, once the cascade-pyramid coverage (Task #53) is broad
enough that `/api/totals` doesn't depend on `gen-1`. Until then: B.

### Phase 3 — Idempotency check

After every rename: re-run the daily compactor / cascade workers for the
last few days, byte-compare outputs to ensure no path-derived state
leaked in. The schema is path-independent — but worth verifying.

## Out of scope (this spec)

- Migrating the `trips/` tree (`trips/stations/<short_name>.parquet`,
  `aggregated/`, `consolidated/`, etc.) — separate top-level concern.
- Changing the cascade-pyramid's `agg=A/cons=C/<period>.parquet`
  internal naming — Hive-style is stable; no proposed change.
- Retiring DVC-tracked `s3/ctbk/...` paths — different pipeline entirely.

## Open questions

- Is `avail/agg/{h1,d1,mo1}/` (gen-1) still used by anything outside
  `/api/totals`? Notebooks? Scripts? If so, the deprecation has more
  surface to cover. `grep -r 'avail/agg/'` outside `gbfs/` returned
  only test fixtures and the api file; should be sufficient but
  worth a second pass before Phase 2.
- The `gbfs/avail/` cleanup (Phase 1) and the cascade-coverage work
  (Task #53) are independent. Phase 1 is small and safe; do first.
  Phase 2 needs Task #53 substantially complete.

## References

- `specs/done/gbfs-scraper.md` — original raw feed pipeline
- `specs/done/avail-perf-pass.md` — multi-scale grid design
- `specs/done/gbfs-r2-only.md` — D1 → R2 migration (introduced `gbfs/avail/h1/`)
- `specs/avail-grid.md` — current cascade-pyramid grid spec
- Task #53 (cascade backfill) — needed before Phase 2
