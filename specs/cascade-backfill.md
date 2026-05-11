# Spec: cascade pyramid backfill + missing tiers

> Status: **draft scoping** (2026-05-11). Surfaces what the health page
> exposes; doesn't yet commit to implementation. Pairs with
> `specs/r2-layout.md` Phase 2 (which depends on cascade-coverage being
> broad enough).

## Surfaced state

`/api/health` and `/health` enumerate three classes of cascade cell:

1. **Deployed + populated** (17 of 18 declared cells today): cascade
   worker writes a shard every bucket-close tick. Coverage extends back
   to 2026-05-03 (when the cascade worker came online); pre-2026-05-03
   has no cascade shards.
2. **Deployed but empty** (1 cell today): `avail/agg=5m/cons=1d/` —
   declared in `gbfs/lib/cascade.ts` `CONS_LEVELS_BY_AGG['5m']` but R2
   has zero shards. **Probable cause**: CFW heap OOM. Inputs for one
   bucket = 3 × `agg=5m/cons=8h` shards. Each 8h shard has 8 h ×
   12 (5-min buckets/hour) = 96 buckets × ~2,407 stations = ~230K
   rows. 3 of them = ~690K rows in heap, larger than the ~433K rows
   that the cascade.ts header comment flags as already OOM-ing for
   `agg=1m × cons=3h`. The day-boundary tick fires but writes never
   land (likely an unhandled exception swallowed by `try { … } catch`
   in `cronTick` step 3 — the error gets pushed to `summary` but
   doesn't fail the worker; next tick retries with same OOM).

   **Fix options**:
   - **(a)** Move `5m × 1d` from `CONS_LEVELS_BY_AGG['5m']`
     (CFW-deployed) into the GHA-runner set. Most direct.
   - **(b)** Stream-concat inputs (read one input shard at a time,
     append rows, drop reference) to keep working-set bounded.
   - **(c)** Bigger-fromCons step: read 24 × `5m × 1h` (smaller
     individual shards, ~57K rows each = 1.36M total — worse) or
     bypass via raw `5m × 5m` (288 × 5-min buckets/day × 2,407 = 693K,
     no help).
   - **(b)** is the structural fix; **(a)** is the quick band-aid.
3. **Specced but not deployed** (18 cells per `gbfs/grid.yaml` but not
   in `gbfs/lib/cascade.ts`): higher-cons levels at `agg=1m` (3h/8h/1d),
   `agg=5m × cons=5d`, `agg=15m × {3d,10d}`, `agg=1h × {3h,8h,3d,1w,1mo,2mo}`,
   `agg=1d × {3d,1w,1mo,3mo,1y,3y}`.

Two separate work items:
- **A: Backfill the deployed+populated cells back to 2026-04-07** (the
  start of WAL data). Requires the cascade `gbfs backfill` CLI to be
  runnable against historical inputs.
- **B: Implement specced-not-deployed cells**. Two sub-classes:
  - **B.1**: CFW-runner-eligible levels (e.g. `agg=15m × 3d`). Add to
    `CONS_LEVELS_BY_AGG`, redeploy cascade worker.
  - **B.2**: GHA-runner levels (e.g. `agg=1m × 1d`, anything ≥3h at
    agg=1m). CFW heap can't handle these (per cascade.ts header
    comment); needs a separate GHA workflow + Python compactor (or
    cascade CLI invocation from GHA).

## A: Historical backfill

### Inputs

Backfilling `agg=A/cons=C` for date D requires reading the next-finer
level for that bucket. The chain bottoms out at `agg=1m/cons=1m`, which
is written by the **loader CFW** from each WAL JSON. The loader's been
running since 2026-05-03 (cascade era), so:

- For dates 2026-05-03 onward: cascade has `agg=1m/cons=1m/<date>/<HHMM>.parquet`
  for each minute. Backfill higher levels from these.
- For dates 2026-04-07 → 2026-05-02 (the early WAL era): no
  `agg=1m/cons=1m` shards. Need to either:
  - **A.1**: Replay WAL JSONs through the loader's transform, write
    `agg=1m/cons=1m/...` for each old minute, then cascade up.
  - **A.2**: Skip backfilling pre-2026-05-03; the health page just shows
    the gap, and users wanting that data use the legacy
    `gbfs/avail/h1/<date>/<HH>.parquet` (which goes back to 2026-04-20)
    or the daily compactions (back to 2026-04-07).

A.1 is the principled fix; A.2 is the pragmatic skip. Recommendation:
A.2 for now — the pre-2026-05-03 data is fully accessible via the
legacy h1 shards (which the `/api/totals` path already reads), and the
backfill cost (~1440 × 26 days = 37,440 minute-shards to write) is
nontrivial.

### Sequencing

Backfill should run *after* layout Phase 1a (`avail/h1/...` migration)
so historical paths are stable. Use the existing `gbfs backfill` CLI:

```bash
gbfs backfill --from 2026-05-03 --to 2026-05-09 --agg 5m --cons 1d --recursive
gbfs backfill --from 2026-05-03 --to 2026-05-09 --agg 1h --cons 1d --recursive
# etc.
```

`--recursive` builds each level's inputs first if missing.

Open question: does `gbfs backfill` against the R2 backend already
work? Last seen state was "manifest list not yet implemented" — but
backfill may not need the manifest. To verify before relying on it.

## B.1: New CFW-eligible cells

`gbfs/lib/cascade.ts` has a header comment listing the design
boundaries: "agg=1m caps at 1h" (heap budget), and "Skipping
1w/1mo/3mo/1y for v1 — those have variable bucket sizes (months) or
different period encodings (ISO week)."

What can be added today as CFW work:

| Add | Source | Why deferred initially |
|-----|--------|------------------------|
| `agg=5m × cons=5d` | `agg=5m × cons=1d` × 5 | small input; never built |
| `agg=15m × cons=3d` | `agg=15m × cons=1d` × 3 | small input; never built |
| `agg=15m × cons=10d` | `agg=15m × cons=1d` × 10 | small input; never built |
| `agg=1h × cons=3h` | `agg=1h × cons=1h` × 3 | small input; never built |
| `agg=1h × cons=8h` | `agg=1h × cons=1h` × 8 | small input; never built |
| `agg=1h × cons=3d` | `agg=1h × cons=1d` × 3 | small input; never built |
| `agg=1d × cons=3d` | `agg=1d × cons=1d` × 3 | small input; never built |

Variable-bucket levels (`1w`, `1mo`, `2mo`, `3mo`, `1y`, `3y`) need
period helpers (ISO week, month boundaries with DST, etc.) before they
fit the cascade's current period-encoding logic. Tractable but bigger.

## B.2: GHA-runner cells (agg=1m wide-cons)

Per the spec, `agg=1m × cons=3h/8h/1d` exist but can't run in CFW:
- 1m × 3h = 180 rows/station × 2407 stations = 433K rows
- After parquet decode + sort: ~30 MB in heap
- CFW's 128 MB heap with allocator + GC overhead OOMs reliably above ~30 MB working set

These need a GHA job that reads the same R2 inputs and writes the
same outputs, dispatched on the same bucket-close cadence (every 3h /
8h / 1d). Simplest: cron-triggered Python script (`compact-agg1m.py`),
runs `gbfs backfill --agg 1m --cons 3h/8h/1d` for the just-closed
bucket.

Open question: do consumers actually need `agg=1m × cons≥3h`? The
multi-scale planner picks the *coarsest* aggregation that satisfies
the requested bin, so a window asking for hourly resolution gets
`agg=1h`-tier shards (much smaller). `agg=1m × cons≥3h` is only useful
if a consumer wants minute-resolution across a multi-hour window — and
those queries are rare. **Recommendation**: defer B.2 indefinitely
until a user surfaces the need.

## Recommended order

1. **Investigate** the empty `agg=5m × cons=1d` cell (Task #51-flagged
   bug). May be a simple fix that fills the most prominent gap on the
   health page.
2. **B.1**: Add small-input cells to `CONS_LEVELS_BY_AGG`. ~30 min;
   redeploy cascade; new shards land on bucket-close.
3. **A.2**: Accept the pre-2026-05-03 gap; document the legacy-h1
   fallback path in `specs/done/avail-perf-pass.md`.
4. **B.2**: punt indefinitely.

## Out of scope (this spec)

- The `gbfs manifest list` CLI implementation (was stubbed not-yet-built
  in the earlier audit).
- Backfill of `gbfs/stations/<uuid>/<yyyymm>.parquet` from older months.
- Trips/aggregated pipeline backfill.

## References

- `specs/avail-grid.md` — grid declaration (source of expectedCells)
- `gbfs/lib/cascade.ts` — `CONS_LEVELS_BY_AGG` (source of deployed)
- `specs/done/avail-perf-pass.md` — original cascade design
- `gbfs/cli/src/cmds/manifest.ts` — `gbfs manifest list` still throws
  "not implemented yet — see specs/avail-grid.md step 5"
- Task #52 (layout cleanup, partially overlaps)
