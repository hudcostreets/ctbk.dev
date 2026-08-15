# GC rides<5 + avail<6 (all legacy pyramids + infra)

**Vision (user, 2026-08-15)**: rides-v5 + avail-v6 are the system; everything earlier — pyramids, pollers, builders, serving routes, FE toggles — gets GC'd. No rush; gate on the first fully-auto month (202608, expected early Sept 2026) proving v5's cadence.

## Already done

- rides-v1/v2 (h3): code + 17.5 GB R2 data GC'd 2026-08-15 (`specs/done/h3-gc.md`).
- rides-v3 monthly rebuild: dropped from ci.yml 2026-08-15 (frozen at 202607; `ctbk rides-v3-extend` remains as a manual tool). The v3 'all'-shard merge-patches were the CI runner's OOM-flakiest phase — three validation-run deaths in one afternoon.

## rides-v3 GC (after 202608 auto-month is green)

- `ctbk/rides_v1.py` wholesale (v3 is its only remaining variant) + `rides-v3-extend`, `rides-v1-build` CLI regs, `import ctbk` wiring, `s2cell`/`pyrmts` deps it alone pulls.
- Worker: `serveRidesV3*`, `VARIANTS`, the parquet-path serve stack in `rides_v1.ts` that v5's inventory-driven path doesn't share; route regex → `rides-v5` only.
- FE: `Pyramid` type → `'v5'` only; drop the toggle + `useRegionCoversV3`'s v3 branch (v5 still uses the covers — rename).
- Data: `rides-v3/` R2 prefix (`ctbk gbfs r2 rm -p`); ~size TBD at GC time. No D1 rows (predates registry).
- Acceptance tooling that references v3 (`rides-v5-accept` compares v5 vs v3): retire or repoint at normalized-source ground truth only.

## avail<6 GC (scope TBD, bigger)

- `avail/` (v3) + `avail-v5/` R2 prefixes; `avail-v6/` stays.
- Lambda cascade (`ctbk-avail-cascade`) if v6 no longer uses it; v3 cron writers/tick paths; `ctbk/avail_v3.py` etc.
- Worker serve paths for old avail pyramids + FE fallbacks.
- Needs its own inventory pass before touching anything — avail has more moving parts (tick Lambda, loader, D1 hot cache, compaction) and v6 shares some.

## Perf note (from the 2026-08-15 backtest)

Current engine throughput ≈ 1M source-rows/s single-job end-to-end (6mo = 123.5M rows in 124.5s). Monthly incremental work is startup-dominated (~1-3 min Batch spinup vs ~1 min compute) — already at the practical floor. Full-history from-scratch (~10-15 min extrapolated) could hit ~2-4 min with a `-V 64`-style fan-out if bulk rebuilds (re-keys, schema changes) ever matter; one flag, not a redesign. The cascade structure (each tier derived from the finer one, fill mode proportional to new data) is already algorithmically optimal — no OoM gains available.
