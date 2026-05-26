# Spec: port Cascade pyramid to pyrmts (with h3 + histogram monoid)

> Status: **§2 + §3a + §3b in EC2 build** (2026-05-25). Replaces the
> laptop-PoC derived from Legacy. Spirit: Cascade is the model; this is
> a *port* onto pyrmts conventions (data, builder, CFW BE, FE) with the
> right monoid (histogram, not Cascade's sum) + h3 + a denser ladder
> than Cascade's. Builds on EC2 because storage is ~tens-of-GB-per-year
> and backfill is embarrassingly parallel.
>
> Progress (2026-05-25, EC2):
> - §2 `ctbk avail-loader-replay`: shipped (`ctbk/avail_loader_replay.py`); content-verified vs loader for 2026-05-12 12:00. Replay in flight for 2026-04-07 → 2026-05-02.
> - §3a `ctbk avail-v2-build --tier 1m`: shipped (`ctbk/avail_v2.py`); 521 1m@1h shards written for 2026-05-03 → 2026-05-25 (~216 MB ≈ 3.6 GB/y projected).
> - §3b cascade (2m–1y): shipped inline (pure-python histogram-combine); sub-hour fan-out in flight. Hourly→day→calendar phases pending.
> - §4: `ctbk avail-v2-probe` + `ctbk avail-v2-validate` shipped.
> - §5: parallel `/api/avail-v2[/cells]` endpoints wired in `gbfs/api/`; PoC `/api/avail-geo[/cells]` still served. Pending: `wrangler deploy` + CIC.
> - §6: pending (after FE confirms parity and migrates fetches).

## Where we are

Three avail aggregation impls today, none with everything we want:

| Impl | Monoid | Ladder | Geo | Consumer |
|---|---|---|---|---|
| **Legacy** `avail/agg/{h1,d1,mo1}` | histogram | sparse 3 tiers | no | `/api/totals` |
| **Cascade** `gbfs/avail/agg=*/cons=*/` | sum (n/sum/sumsq) | **dense 5×8 grid** | no | nothing |
| **PoC** `avail-geo/{h1,d1,mo1}` | histogram | Legacy-shaped | **yes** | `/api/avail-geo[/cells]` |

V2 collapses these into one pyramid that has: dense ladder (Cascade-
shaped + denser at the interactive sub-hour band), histogram monoid
(supports all reducers exactly — bounded-discrete state space), and
h3 (every materialized resolution inline per pyrmts-geo convention).
All three predecessors become deletable.

## Pyramid shape

```yaml
axis: time
binCol: dt                       # int64 unix ms
keyTemplate: 'avail-v2/{tier}/{period}.parquet'

dims: [{ name: h3_cell, type: string }]

metrics:                         # histogram monoid, LogicalType=JSON column per metric
  - { name: bikes,    monoid: histogram }
  - { name: ebikes,   monoid: histogram }
  - { name: docks,    monoid: histogram }
  - { name: disabled, monoid: histogram }
  - { name: pending,  monoid: histogram }

tiers:    # finest → coarsest; max SUF ~2× in the interactive sub-hour band
  - { name: '1m',   bin: 1m,   shard: 1h  }   # 60 bins/h
  - { name: '2m',   bin: 2m,   shard: 1h  }   # 30 bins/h  (SUF→2m = 2×)
  - { name: '3m',   bin: 3m,   shard: 1h  }   # 20 bins/h  (→3m = 1.5×)
  - { name: '5m',   bin: 5m,   shard: 1d  }   # 288 bins/d (→5m = 1.67×)
  - { name: '10m',  bin: 10m,  shard: 1d  }   # 144 bins/d (→10m = 2×)
  - { name: '15m',  bin: 15m,  shard: 1d  }   # 96 bins/d  (→15m = 1.5×)
  - { name: '30m',  bin: 30m,  shard: 1d  }   # 48 bins/d  (→30m = 2×)
  - { name: '1h',   bin: 1h,   shard: 1mo }   # 720 bins/mo (→1h = 2×)
  - { name: '2h',   bin: 2h,   shard: 1mo }   # 360 bins/mo (→2h = 2×)
  - { name: '3h',   bin: 3h,   shard: 1mo }   # 240 bins/mo (→3h = 1.5×)
  - { name: '6h',   bin: 6h,   shard: 1mo }   # 120 bins/mo (→6h = 2×)
  - { name: '12h',  bin: 12h,  shard: 1mo }   # 60 bins/mo  (→12h = 2×)
  - { name: '1d',   bin: 1d,   shard: 1y  }   # 365 bins/y  (→1d = 2×)
  - { name: '3d',   bin: 3d,   shard: 1y  }   # 122 bins/y  (→3d = 3×)
  - { name: '7d',   bin: 7d,   shard: 1y  }   # 52 bins/y   (→7d = 2.3×)
  # Calendar tiers — variable bucket sizes, looser SUF acceptable
  - { name: '1mo',  bin: 1mo,  shard: 1y  }   # 12 bins/y   (→1mo = 4.3×)
  - { name: '3mo',  bin: 3mo,  shard: 1y  }   # 4 bins/y    (→3mo = 3×)
  - { name: '1y',   bin: 1y,   shard: all }   # (→1y = 4×)

geo:
  cellCol: h3_cell
  resolutions: [9, 7, 5]         # finest first; add res 3 later if regional zoom needed
```

**Storage** (rough): ~20 GB/y for the 1m tier (dominant), harmonic decay for finer-bin tiers means total ~40–50 GB/y. EC2 must be the host.

## Source

`gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` — the loader's per-
station-per-minute output. Each row has `(n=1, sum=state, sumsq=state²)`
for each metric; n=1 ⇒ `state == sum`, so converting to a single
histogram observation `{state_str: 1}` is lossless.

The loader has been running since **2026-05-03**. Pre-2026-05-03 data
exists only as WAL JSONs (`gbfs/status/<date>/<HH-MM>.json`, back to
**2026-04-07**). To avoid a coverage gap:

1. Implement `ctbk avail-loader-replay --from 2026-04-07 --to 2026-05-02`
   that re-runs the loader's WAL-JSON-to-1m@1m transform for the old
   minutes. Output goes to the same `gbfs/avail/agg=1m/cons=1m/` path.
2. Then the v2 build reads 1m@1m uniformly across the full 2026-04-07
   → present range.

# EC2 RUNBOOK

> This section is self-contained for an EC2 session to execute.
> Assumes the user has pushed a fresh clone of both `~/c/pyrmts/` and
> `~/c/hccs/ctbk/` (this repo) to the EC2 node, and configured R2
> creds in `.envrc`.

## 0. Setup

```bash
# Verify env
cd ~/c/hccs/ctbk
direnv allow                      # picks up R2_* creds, CLOUDFLARE_ACCOUNT_ID
ctbk --help                       # sanity (uv-managed venv)
pip install h3 polars pyarrow     # h3 and polars used below; pyarrow already pinned

cd ~/c/pyrmts/python
uv sync                            # if pyrmts-python is being built here too
```

## 1. Pyrmts-side helpers (do first, in parallel with §2)

Two helpers go into pyrmts so they're reusable by awair/tomat/etc.:

### `pyrmts.cascade_tiers` (Python or TS, ideally both)

```py
def cascade_tiers(pyramid: Pyramid, range: TimeRange, finest_tier: str) -> None:
    """Given a pyramid whose `finest_tier` is fully populated for `range`,
    build every coarser tier by combining the finest's shards via the
    pyramid's monoid catalog. Idempotent: skips outputs that already
    exist with the same row count."""
```

Pure axis arithmetic + monoid combine. No GBFS/h3 specifics.

### `pyrmts_geo.materialize_resolutions(rows, geo, lat_lng_lookup) -> rows`

```py
def materialize_resolutions(
    rows: Iterable[dict],          # input with lat/lng or `station_id` resolvable to (lat, lng)
    geo: GeoSpec,                   # cellCol, resolutions
    lat_lng_lookup: Callable[[str], tuple[float, float] | None],
) -> Iterable[dict]:
    """For each input row, emit one row per materialized h3 resolution,
    with `h3_cell` set to the corresponding cell ID. Caller supplies the
    lat/lng resolver (project-specific)."""
```

Pure h3 + groupby logic, project-agnostic.

These are NOT blocking — they're "nice to have shipped to pyrmts." If
not ready by the time the ctbk build runs, ctbk can inline them locally
and PR them to pyrmts after.

## 2. WAL replay backfill (ctbk)

```bash
# Goal: fill gbfs/avail/agg=1m/cons=1m/ for 2026-04-07 → 2026-05-02 by
# replaying the existing WAL JSONs through the loader's transform.

ctbk avail-loader-replay \
  --from 2026-04-07 \
  --to 2026-05-02 \
  --concurrency 16            # WAL JSON parse + parquet write are I/O-bound

# Expected throughput: ~1000 minutes/sec on a beefy EC2 node ⇒ 26 days
# × 1440 minutes = ~37K minutes / 1000 ≈ ~40 seconds wall. Slowest step
# is R2 GET of WAL JSONs; parallelize per-minute aggressively.
```

Implementation outline: lift `gbfs/loader/src/index.ts`'s
WAL→1m@1m transform into a Python equivalent (or call into the
existing JS loader via Node, if simpler). Per minute:
1. R2 GET `gbfs/status/<date>/<HH-MM>.json`
2. Parse + transform to a single-row parquet (1 row × ~2400 stations).
3. R2 PUT `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`.

Idempotent: if output already exists with matching row count, skip.

## 3. V2 pyramid build (ctbk, EC2-resident)

```bash
# Goal: produce avail-v2/{1m..1y}/<period>.parquet for the full coverage
# (2026-04-07 → today). Writes to R2 directly; no local 58 GB hoarding.

# 1m tier — directly from 1m@1m source (per-minute, h3-resolved + multi-res)
ctbk avail-v2-build \
  --tier 1m \
  --from 2026-04-07 \
  --to $(date -u +%Y-%m-%d) \
  --concurrency 24            # 1m × 1h shards are independent; ~17K shards in scope

# 2m..30m tiers — derived from 1m via monoid combine
for tier in 2m 3m 5m 10m 15m 30m; do
  ctbk avail-v2-build --tier "$tier" --derive-from 1m \
    --from 2026-04-07 --to $(date -u +%Y-%m-%d) --concurrency 24
done

# 1h..12h tiers — derived from finest sub-hour that evenly divides
for tier in 1h 2h 3h 6h 12h; do
  ctbk avail-v2-build --tier "$tier" --derive-from 30m \
    --from 2026-04-07 --to $(date -u +%Y-%m-%d) --concurrency 8
done

# 1d..7d tiers — derived from 1h (smaller inputs after the hour rollup)
for tier in 1d 3d 7d; do
  ctbk avail-v2-build --tier "$tier" --derive-from 1h \
    --from 2026-04-07 --to $(date -u +%Y-%m-%d) --concurrency 4
done

# Calendar tiers — small, fast
for tier in 1mo 3mo 1y; do
  ctbk avail-v2-build --tier "$tier" --derive-from 1d \
    --from 2026-04-07 --to $(date -u +%Y-%m-%d) --concurrency 2
done
```

Each invocation is idempotent (skip-if-exists), so re-running is safe.

### Build-script implementation outline

```py
@ctbk.command('avail-v2-build')
@option('--tier', required=True)
@option('--derive-from', default=None)       # None = read 1m@1m source
@option('--from', 'date_from', required=True)
@option('--to',   'date_to',   required=True)
@option('--concurrency', default=8)
@option('--dry-run', is_flag=True)
def avail_v2_build(...):
    """Build avail-v2/<tier>/ shards for [date_from, date_to)."""
    spec = TIER_SPECS[tier]  # bin, shard, derive_from
    shards = enumerate_shards(spec.shard, date_from, date_to)
    missing = [s for s in shards if not r2_exists(f'avail-v2/{tier}/{s}.parquet')]
    if dry_run: print(missing); return
    with ProcessPoolExecutor(concurrency) as pool:
        list(pool.map(lambda s: build_one_shard(tier, s, spec, station_geo), missing))
```

`build_one_shard`:
- If `derive_from` is None: read 1m@1m source shards in [shard.from, shard.to),
  group by h3_cell × resolution × time-bucket, materialize each metric's
  histogram, write parquet.
- If `derive_from` is set: read avail-v2/<derive_from>/<sub-shards>.parquet,
  combine histograms (sum maps key-wise) per (h3_cell, time-bucket).

Use Polars for the source scan + groupby; pyarrow for parquet I/O.
Output histograms as `LogicalType=JSON` columns (pyarrow ≥18 supports
`pa.json_extension_type()`; otherwise emit JSON-string and tag with
metadata).

## 4. Validation

```bash
# Sanity check shard sizes + row counts
ctbk avail-v2-probe -s 1

# Cross-check against the existing PoC (avail-geo/h1/<date>) for the
# h1 tier. NOTE: values do NOT match exactly — PoC reads tall-format
# `avail/agg/h1/` (Cascade compactor's source, which has dropouts: mean
# ~37 / max 55 minutes per (station,hour,metric)); v2 reads the loader's
# 1m@1m shards directly (full 60 minutes when station is present). v2 is
# more complete by design. The validator surfaces the diff for inspection
# but a non-zero diff count is expected.
ctbk avail-v2-validate -d 2026-05-22,2026-05-23

# Hit the new endpoint dry-run from EC2 (CFW serves a dev branch
# pyramid)
curl -A 'ctbk-probe' "$WORKER_URL/api/avail-v2?from=...&to=...&bbox=...&bin_budget=24&cell_budget=200"
```

## 5. Wire-up (laptop, post-EC2-build)

After EC2 has written shards to R2:

1. Expose v2 as **parallel** endpoints `/api/avail-v2[/cells]` rather
   than repointing `/api/avail-geo[/cells]`. Both routes share the
   serve-handler pipeline (`serveGeoReduced`); only the pyramid factory
   differs (PoC: `avail-geo/<tier>` + 3-tier ladder; v2: `avail-v2/<tier>`
   + 10-tier ladder). Existing FE consumers of `/api/avail-geo` stay on
   PoC data; v2 is opt-in via URL.
2. Shadow-mode dual-read against the PoC for a week to confirm parity
   (or surface the expected gap, since v2 is more complete by design —
   see §4 validator note).
3. Cut over: switch FE fetches from `/api/avail-geo` → `/api/avail-v2`.
4. Decommission predecessors (loader keeps running; everything else
   stops or gets deleted). Drop `/api/avail-geo[/cells]` routes after
   FE confirms no remaining callers.

> Earlier draft of this section called for repointing `/api/avail-geo`
> at v2 data directly (commit `67e20d50`). Replaced with the parallel
> approach above to honor step 2's shadow-mode requirement before any
> data the FE depends on changes shape.

## 6. Things NOT to do on EC2

- ~~Don't push to `h:main` (Github). Push to `e:` (EC2-mediator remote)
  only. CI deploy on `h` would break due to `workspace:*` pyrmts deps.~~
  No longer applies (2026-05-25): pyrmts has a `dist` branch on GitHub
  and `gbfs/api/` is on `pds gh` refs, so `git push h main` triggers a
  clean CI deploy. Push to `h:` freely.
- Don't run the live CFW workers from EC2. Keep `wrangler deploy` on
  the laptop (or skip it entirely until the build is verified).
- Don't delete any of the legacy/cascade/PoC data on R2 — keep through
  the validation period.

## 7. Rebuild: parquet layout for read-side pruning (EC2, follow-up)

> Added 2026-05-25, after CFW OOMs surfaced on `/api/avail-v2[/cells]`
> sub-day queries.

### Diagnosis

`ctbk avail-v2-build` wrote shards with pyarrow defaults:
- `num_row_groups = 1` per shard (default `row_group_size=1M`; v2 1h
  shards have ~956K rows, so they fit in a single RG).
- Rows sorted `(cell, dt_sec)` (see `avail_v2.py:272`).

Together this defeats hyparquet's row-group `dt`-stats pruning:
even when the CFW reader passes `binCol='dt' + range=…` (now wired in
`avail_geo.ts` + `avail_pyrmts.ts`), there's only one RG, and its
`dt`-stats span the entire shard period. So every query loads the
whole decompressed shard (~130 MB for v2 1h) → blows the 128 MB CFW
free-tier memory limit on any sub-day query.

This is the unaddressed half of pyrmts SPEC.md "Open questions" §
("Row-group sizing" + "Sort order"). The reader has the pruning
primitive; the writer doesn't yet have a convention or helper.

### Changes

In `ctbk/avail_v2.py`:

1. **Resort rows by `(dt, cell)`** instead of `(cell, dt)`. h3's
   resolution-in-high-bits property is nice-to-have for resolution
   pruning but pyrmts doesn't currently do that pruning, so dt-first
   is the right primary key for now. (Lines 272 + 457; both shard
   writers.)
2. **Set `row_group_size`** in the `pq.write_table(...)` call (line
   296). Start with `8192`; tune if needed. Goal: each RG covers a
   narrow `dt` window so stats prune effectively.
3. (Optional, defer if it's not necessary for the OOM fix) **Sort
   monoid output similarly** in the cascade step — if cascaded tiers
   inherit the input shape this happens for free, otherwise mirror
   the change.

### Rebuild driver

All built (tier × period) pairs need re-write. From EC2:

```bash
# Idempotent re-runs are fine — they overwrite. Order doesn't matter
# semantically but build finest tiers first so cascade has its inputs.
ctbk avail-v2-build --tier 1m --force   # ~521 shards across 49 dates
# Then cascade up
ctbk avail-v2-build --tier 2m --derive-from 1m --force
# … continue through the ladder up to 1y
```

(If `--force` doesn't exist yet on `avail-v2-build`, add it — flag to
overwrite existing R2 objects rather than skip-if-exists.)

Total rebuild scope: 18 tiers × shards-per-tier. Embarrassingly
parallel per (tier, period); current 1m build took ~hours on EC2,
expect similar.

### Validation

After rebuild, the OOM-reproducer should now succeed:

```bash
curl -A 'ctbk-probe' \
  "https://ctbk-gbfs-api.ryan-0dc.workers.dev/api/avail-v2?from=2026-05-22T00:00:00Z&to=2026-05-23T00:00:00Z&bbox=40.74,-74.00,40.78,-73.96&bin_budget=24&cell_budget=200"
```

Expect 200 + small JSON body (~few KB). If still OOMs: inspect the
shard's `pqm` output — `num_row_groups` should be hundreds, each
row group's `dt` stats should span minutes-to-low-hours, not the
full shard period.

### Note: read-side patches already landed

- `gbfs/api/src/avail_geo.ts` threads `{ binCol, range }` to
  `fetchSegmentRows` (commit `7ddb7104`).
- `gbfs/api/src/avail_pyrmts.ts` (shadow mode) threads the same opts
  to `fetchShardData` (next commit).

Both are no-ops until this rebuild lands; once it does, they take
effect without further CFW changes.

### Upstream pyrmts follow-up

Open SPEC.md questions §321/§323 ("Row-group sizing", "Sort order")
become tractable now that ctbk has a real layout pin. Worth proposing
a `pyrmts.write_tier_parquet(rows, pyramid, …)` helper that handles
RG sizing + binCol-first sort by default, so future consumers don't
hit this trap.

## Open

- Histogram column format: `pa.json_extension_type()` (pyarrow ≥18)
  for native LogicalType=JSON, OR plain `pa.string()` with JSON content
  + post-write metadata patch. Verify hyparquet (the CFW reader) auto-
  decodes the former before committing.
- Sub-1m tiers (10s, 30s)? — loader writes at 1m granularity, so no
  native source. Skip.
- Trips pyramid — same template (per-ride raw → tier pyramid with h3
  + dim breakdowns) but separate effort. After avail v2 lands.

## References

- `~/c/pyrmts/SPEC.md` — pyrmts core design
- `~/c/pyrmts/js/packages/pyrmts-geo/` — geo extension (planQuery,
  serveGeoQuery; ~1.1K LoC)
- `gbfs/loader/src/index.ts` — WAL → 1m@1m transform (port to Python
  for replay step)
- `gbfs/cascade/src/index.ts` — original Cascade compactor (read for
  tier-cascade reference; will be retired)
- `ctbk/avail_geo.py` — PoC build (read for h3-materialization
  reference; will be superseded)
- `specs/avail-geo-pyramid.md` — PoC spec (will be marked superseded)
- `specs/cascade-backfill.md` — Cascade context (will be retired)
