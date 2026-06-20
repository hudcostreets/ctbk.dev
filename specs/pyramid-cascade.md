# pyramid-cascade: general multi-pyramid build CLI

## Goal

A reusable CLI for cascading-pyramid generation that supports both ctbk
pyramids (avail, rides). One pass over the base tier emits all derived
tiers per block; the orchestrator splits the date range into parallel
blocks and runs a small reduce phase to merge partial shards at block
boundaries.

**Parallelism is block-bounded.** With `task_size=1d` and an N-day
rebuild, there are N blocks → `-j > N` buys nothing. For a 60-day
range and 32 workers, ~2 blocks per worker (decent, not saturated).
Pushing past ~8-16 workers on small rebuilds requires either a smaller
`task_size` (more, smaller blocks) or sub-block parallelism (e.g.
parallel tier-emit within a block) — neither shipped yet; tracked as
followup.

Replaces the per-pyramid ad-hoc cascade scripts (`cascade_from_1m` in
`ctbk/avail_v3.py`, `cascade_tiers` in `ctbk/rides_v1.py` ancestors,
`scripts/avail-v3-cascade.sh`) with one tool that takes the pyramid's
tier list as configuration.

## Non-goals

- **Live/in-progress shard maintenance.** The existing CFW compactor
  (`gbfs/compactor/`) handles incremental updates for the current day's
  /1m shards and the hourly h1 cascade. Pyramid-cascade processes only
  **completed** source shards — `-r` excludes the in-progress tail.
- **Query-time planning.** That's pyrmts (see
  `~/c/pyrmts/specs/multi-tier-bin-packing.md`).
- **Cross-pyramid joins.** Each invocation builds one pyramid.

## CLI surface

```bash
ctbk pyramid-cascade \
    -c configs/pyramids/avail.yaml \             # required: pyramid config
    -i avail \                                   # required: built-in ingester
    -r 2026-04-08/2026-06-19 \                   # range (excludes in-progress)
    -t 1d \                                      # block / task size
    -j 16 \                                      # workers (default: 1)
    -s file:///tmp/cascade-$$/                   # staging URI (default: tmp)
```

Tier list, dims, metrics, RG sizes etc. live in the YAML config —
they're stable per pyramid; the CLI takes invocation-level args only.
Configs live at `configs/pyramids/{avail,rides}.yaml` (project root,
not under `ctbk/`).

Currently only `avail.yaml` is shipped; `rides.yaml` is the next step
(see #109).

## Tier list (shared layout for both pyramids)

Both pyramids use the same S2-cell LUC scheme (#108, #109) and `1m@1d`
base, so the **target** layout is identical. Differences:
- Avail caps at `/7d` (no `1mo`/`3mo`/`1y` while data is < 1y old).
  Adding them later is a YAML-only edit (no enforcement in code).
- Rides keeps calendar tiers since data spans 13+ years.

### Target (full N≈1440 scheme — pyrmts-py multi-unit calendar shards)

```
1m@1d, 2m@2d, 3m@3d, 5m@5d, 10m@10d, 15m@15d                       # epoch-anchored, N=1440
30m@1mo, 1h@2mo, 2h@4mo, 3h@6mo, 6h@1y, 12h@2y                     # calendar-anchored
1d@4y, 3d@all, 7d@all                                                # mixed (3d/7d roll up rare)
1mo@all, 3mo@all, 1y@all                                            # calendar (rides only)
```

### Shipped (single-unit calendar shards)

Pyrmts-py's `floor_to_span` currently refuses multi-unit calendar bins
like `2mo`, `4mo`, `2y` (#122). Until that lands, calendar shards are
single-unit. Shipped `avail.yaml`:

```
1m@1d, 2m@2d, 3m@3d, 5m@5d, 10m@10d, 15m@15d                       # epoch-anchored, N=1440
30m@1mo, 1h@1mo, 2h@1mo, 3h@1mo, 6h@1y, 12h@1y, 1d@1y               # calendar (single-unit)
3d@all, 7d@all
```

This shrinks per-tier N for the hourly tiers (1h@1mo = 720 vs 1440
target) — still much better than the old pyramid's 1h@1mo + 12h@1mo,
and acceptable until #122 lands.

Sizing principle: target **N ≈ 1440 bins per shard** (matches `1m@1d`
reference). Epoch-anchored for fixed-duration tiers, calendar-anchored
for the rest. See "epoch vs calendar" below for why we accept both.

## Algorithm

### Map phase (one task per block)

For each block `[t_block_start, t_block_end)`:

1. **Ingest**: stream source rows from `[t_block_start, t_block_end)` via
   the pyramid-specific ingester callable.
2. **Cascade**: for each row `(cell, dt, …)`, dispatch into per-output-tier
   accumulators keyed by `(cell, _bin_floor(tier, dt), metric)`.
3. **Flush at boundaries**: when source time crosses an output shard
   boundary for tier T, write T's now-complete shard. If the block
   **fully owns** that shard (block window covers the whole output
   period), write to the final R2 path. Else write to staging.

A block fully owns an output shard when the shard's `[from, to)` is
contained within the block's range. For `--task-size 1d`:
- Only `1m@1d` (shard exactly = task_size) is fully owned by its
  day-block — and we don't write it (base tier; see "1m base passthrough"
  below).
- Every other shipped tier has a shard larger than 1d → block straddles
  → write partial → staging:
  - `2m@2d`, `3m@3d`, `5m@5d`, …, `15m@15d`
  - `30m@1mo` through `12h@1y`
  - `1d, 3d, 7d` @ 1y or `all`
- So at `task_size=1d`, *every* derived tier goes through staging + reduce.
  Pick a larger `task_size` (e.g. `1mo`) to write `5m@5d`..`15m@15d` direct.

### 1m base passthrough

The cascade does **not** write the `1m@1d` base tier — that's the
ingester's input, owned by the live compactor (`gbfs/compactor/` →
`gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`). The pyramid is built
from the existing 1m source; the worker reads `/1m` queries from that
legacy path. Only the **derived** tiers (`2m, 3m, …, 7d`) flow through
pyramid-cascade and into `avail-v3/<tier>/<period>.parquet`.

### Shuffle (between phases)

Partial shards write to local `/tmp` (`--staging file:///tmp/cascade-$$/`)
by default — fastest, no R2 PUT cost. Only switch to R2 (`s3://…`) for
multi-node execution.

Staging layout: `<staging>/<tier>/<period>/<block_id>.parquet`. After
map phase, each (tier, period) directory has 1 file (if 1 block
contributed) or N files (if N blocks contributed).

### Reduce phase (one task per multi-block output shard)

For each `(tier, period)` with `N > 1` staged files:

1. Read all N partial parquets.
2. Concat + groupby `(s2_cell, dt_out, metric)` + histogram-sum.
3. Sort by `(s2_cell, dt_out)`.
4. Write final shard to `avail-v3/<tier>/<period>.parquet`.
5. Delete the staged partials.

After reduce: delete the staging directory.

### Parallelism

- **Map phase**: trivially data-parallel; one process per block, `-j N`
  workers via `multiprocessing.Pool`. Each block independent.
- **Reduce phase**: also data-parallel; one process per `(tier, period)`,
  same pool. Independent.
- **Bottleneck**: shuffle disk-write between phases. Shouldn't dominate;
  partials are small (one block × one tier's contribution).

Expected scaling: linear with cores **up to the block count**. Reduce
is much smaller; usually a few percent of wall time.

## Engine

**Polars**. Per-block ingestion + group-by + histogram-merge runs in
Polars expressions, much faster than the Python dict loop in the
legacy `cascade_from_1m`. Per-block memory ~1.3 GB (avail / 1-hour
input, measured) — bounded by the source Arrow columnar size, not by
Python object overhead.

In-flight design: streaming applies to the **ingest + long-form melt**
phase (`long_lf.collect(engine='streaming')` at block start); subsequent
per-tier work iterates the collected long-form DataFrame eagerly, since
each tier needs the full block's rows for its groupby. So "in-flight
state" = one block's long-form table — not infinite.

Histogram representation: stored as JSON strings in the parquet (Polars
can't natively decode arbitrary-key JSON into a typed struct). Per-row
parsing happens at melt-and-groupby time. (Future: native Map types in
parquet via hyparquet upgrade.)

## Ingester contract

Each pyramid supplies an "ingester" callable:

```python
def ingester(block_range: tuple[datetime, datetime]) -> pl.LazyFrame:
    """Return a LazyFrame of base-tier rows in `block_range`.

    Schema: { s2_cell: str, dt: int (unix ms), bikes: Map<int,int>,
              ebikes: Map<int,int>, ... }
    """
```

Built-in ingesters:
- `--ingester avail`: reads `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`
  source, materializes per-station LUC + ancestors per the existing
  `build_1m_hour_table` logic. Polars-ified.
- `--ingester rides`: reads monthly CSV.zip from S3 tripdata, splits each
  ride into start/end events, bins by minute and cell.

For one-off pyramids, callers can pass `--ingester-module
my_module.fn_name` to plug in their own. Ingester contract is part of
pyrmts-py once we factor.

## Epoch vs calendar shard anchoring

Both modes supported:

- **Epoch-anchored** (`2m@2d`, `15m@15d`, etc.): shard boundary =
  `floor(epoch_ms / shard_ms) × shard_ms`. Trivial math. Use for
  sub-day-bin tiers where N=1440 lands on clean multiples.
- **Calendar-anchored** (`30m@1mo`, `1h@2mo`, `1mo@all`, etc.): shard
  boundary = calendar month/quarter/year. Use for hourly+ tiers and all
  calendar-bin tiers (1mo, 3mo, 1y).

The shard-spec parser dispatches on the unit suffix: `Nd` → epoch
arithmetic, `Nmo`/`Ny`/`all` → calendar arithmetic. Pyrmts-py provides
a `shard_boundaries(spec, range) → Iterator[(start, end)]` helper that
hides the dispatch.

For multi-tier bin packing (pyrmts side), the planner uses the same
`shard_boundaries` helper to know where each tier's shard borders fall
when decomposing arbitrary-phase output bins.

## Storage projections

At measured ~30 B/row compressed (snappy), with ~5 k unique cells
materialized per minute (after LUC + ancestors):

| timeline | avail | rides | total | annual R2 cost |
|---|---:|---:|---:|---:|
| EOY 2026 (~8mo avail + 13y rides) | ~75 GB | ~8 GB | ~85 GB | $15 |
| EOY 2027 | ~175 GB | ~10 GB | ~190 GB | $34 |
| EOY 2030 | ~475 GB | ~15 GB | ~490 GB | $88 |
| EOY 2036 | ~1 TB | ~25 GB | ~1 TB | $185 |

Linear growth (~$15/year increment, never plateaus). Halves with zstd
once hyparquet supports it (~6 mo away).

Rides 1m is sparse (~30–50 trip events per minute globally) — total 1m
tier ~5 GB for 13y. Avail 1m is dense (every station polled every minute)
— ~55 GB per year.

## Row-group sizing

Per-tier RG size tunable via `--rg-size-rows N` (default: pyrmts default
of 16384). For fine tiers where single-cell queries dominate, smaller
RGs (~2k rows) win on data scan but lose on footer overhead — net
break-even at ~4–8k rows for our 7-column schema.

**v1**: ship with pyrmts default (16k); add per-tier override later
after benchmarking. Bench plan:

1. Write 3 shards of `15m@15d` at RG sizes ∈ {2k, 4k, 8k, 16k, 64k}.
2. Cold-query each via the worker for: (a) single-cell × full window,
   (b) single-cell × sub-window, (c) bbox × full window.
3. Measure CPU + wall + bytes-fetched.
4. Pick the per-tier winner.

## Integration with existing compactor

Pyramid-cascade is for **completed shard** generation. The CFW
compactor (`gbfs/compactor/`) is for **in-progress shard** maintenance:

- Poller (every minute): writes WAL JSONs to `gbfs/status/<date>/<HH-MM>.json`
- Hourly compactor (HH:05): rolls WAL → `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`
- Daily compactor (GHA at 00:15 UTC): builds prior day's h1/d1/mo1 aggs

The query planner uses watermarks (#115) to stitch:
- Past-completed periods served from pyramid-cascade outputs
- In-progress current period served from the compactor's finer-tier outputs

Pyramid-cascade's `-r` argument should exclude the in-progress tail
(typically yesterday-or-earlier as upper bound). Cron the cascade nightly
to roll the prior day into pyramid form once compactor finishes its
daily aggs.

## Dependencies

- **pyrmts-py** (Python): `shard_boundaries`, `bin_floor`, `tier_spec`,
  `write_tier_parquet` (existing), eventually the `cascade` module
  housing the algorithm.
- **Polars**: build engine.
- **multiprocessing**: parallelism.
- **boto3 / s3fs**: R2 I/O.

For now, build the algorithm in this repo; factor to `pyrmts-py` once a
second user emerges. Develop pyrmts changes locally via `pds l pyrmts-py`.

## Migration plan

1. **Build `pyramid-cascade` CLI** in this repo, single-pyramid first.
   Independent of pyrmts query-side changes (cascade is build-side only).
2. **Validate avail rebuild** end-to-end on `e` with new tier list.
   Probe perf; CIC StationDetail with `availSrc=v3`.
3. **Rides pyramid-v3-LUC backfill** (#109). Uses the same tool.
4. **Phase 3 cleanup** (#112): retire `cascade_from_1m`,
   `cascade_tiers`, `scripts/avail-v3-cascade.sh`.

In parallel (not blocking):
- **pyrmts multi-tier bin packing** (shipped — pyrmts commit
  `b373195`). Unlocks arbitrary-phase, arbitrary-width queries via
  `targetBin`. The build tool produces shards compatible with both
  legacy single-tier and new multi-tier planners.
- **pyrmts-py multi-unit calendar shards** (#122) — when this lands,
  swap `avail.yaml` to the multi-unit target layout (1h@2mo etc.) for
  the cleaner N=1440 sizing.

## Resolved

1. **Hyparquet zstd**: no fork changes needed. Hyparquet accepts a
   `compressors: { [codec]: fn }` arg (`datapage.js:114-127` in
   `runsascoded/hyparquet`). For zstd, import a JS zstd decoder (e.g.
   `fzstd`) in the worker and pass it as `compressors.ZSTD`. Defer until
   storage cost matters; snappy is fine for v1.
2. **Per-tier RG-size override**: default `2k` rows for all tiers;
   override per-tier via the config (see "Config file" below). Pyrmts
   writer accepts `row_group_size` already.
3. **Ingester contract**: ctbk-internal for v1. Each pyramid supplies
   its `(block_range) → pl.LazyFrame` callable. Factor to pyrmts-py
   after a second project hits the same shape.
4. **Tier list as config, not CLI**: ctbk pyramids are stable enough
   that the tier list belongs in a config file, not on the command line.
   CLI takes invocation-level args (range, workers, staging path).

## Config file

`ctbk/configs/pyramids/{avail,rides}.yaml`:

```yaml
# avail.yaml
name: avail-v3
base:
  tier: 1m
  shard: 1d
  rg_size: 4096          # override default 2k for the dense base tier
  ingester: ctbk.avail.ingest_1m
tiers:
  - { bin: 2m,  shard: 2d   }
  - { bin: 3m,  shard: 3d   }
  - { bin: 5m,  shard: 5d   }
  - { bin: 10m, shard: 10d  }
  - { bin: 15m, shard: 15d  }
  - { bin: 30m, shard: 1mo  }
  - { bin: 1h,  shard: 2mo  }
  - { bin: 2h,  shard: 4mo  }
  - { bin: 3h,  shard: 6mo  }
  - { bin: 6h,  shard: 1y   }
  - { bin: 12h, shard: 2y   }
  - { bin: 1d,  shard: 4y   }
  - { bin: 3d,  shard: all  }
  - { bin: 7d,  shard: all  }
defaults:
  rg_size: 2048
  compression: snappy      # zstd later
```

CLI becomes:

```bash
ctbk pyramid-cascade -c avail.yaml -r 2026-04-08/2026-06-19 -j 32
```

Rides config differs only by `name`, `ingester`, and the additional
calendar tiers `{1mo@all, 3mo@all, 1y@all}`.
