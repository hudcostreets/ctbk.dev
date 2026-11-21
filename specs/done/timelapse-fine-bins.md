# Timelapse fine bins: any bin, sub-hour tiers, sliding windows, linked controls

> **Done** (spec triage, 2026-11-19): F1–F4 deployed (`cb4710bc`); API serves `rides-tl-fine`.

Status: F1–F3 deployed; F4 controls deployed and movie capture verified locally (2026-10-11; user authorized the full roadmap).
Author: Ryan + Claude
Builds on: [`timelapse-map.md`] (the `rides-tl-{start,end}` time-first pyramids, `/api/tl`, frame grid, P0/P4 measurements); [`rides-tl-start.yaml`].

## Goal

Make the timelapse a multi-scale stack that goes below `1h`, and let users pick **any** bin, not just a built tier:

1. `/api/tl` serves any bin that is a whole multiple of a built tier, by summing the coarsest built tier that divides it. How dense the tier ladder is becomes a cost choice. It no longer limits which bins users can pick.
2. Sub-hour tiers: a `1m` base, plus `15m` (and optionally `5m`/`30m`).
3. A sliding window. Frames step every `1m`/`5m`, and each frame shows the trailing `w` (e.g. `30m`), summed in the browser.
4. Four linked controls (bin, fps, range, movie length), solved LRU-style by a small generic module.

## Measurements (provenance)

All tier-size numbers below come from a local simulation on June 2025 start-anchor rides (`normalized/202506.parquet`, 4,835,785 rides starting in June). The simulation groups by `(s:<Start Station ID>, floor(start, bin))` and sorts `dt,cell`. Columns are `cell, dt, count_{n,sum,sumsq}`, written with pyarrow, snappy, `row_group_size=32768`, which is the `rides-tl` shard layout. **It reproduces P0b's Batch-built June 2025 `1h` tier byte for byte in size (3.78 MB)**, so the per-tier numbers can be trusted as shard-size estimates. Scratch files are in `tmp/fine/` (`sim-*.parquet`, `sim-bytes.txt`).

| bin | rows | rows/ride | MB (June 2025) | B/row | B/ride | full history, per anchor |
|---|---|---|---|---|---|---|
| `1m` | 4,221,660 | 0.873 | 11.04 | 2.62 | 2.28 | **~0.78 GB** |
| `2m` | 3,848,364 | 0.796 | 10.69 | 2.78 | 2.21 | ~0.76 GB |
| `5m` | 3,136,362 | 0.649 | 9.50 | 3.03 | 1.96 | ~0.67 GB |
| `10m` | 2,471,983 | 0.511 | 8.15 | 3.30 | 1.69 | ~0.58 GB |
| `15m` | 2,070,288 | 0.428 | 7.22 | 3.49 | 1.49 | **~0.51 GB** |
| `30m` | 1,437,556 | 0.297 | 5.27 | 3.66 | 1.09 | ~0.37 GB |
| `1h` | 932,945 | 0.193 | 3.78 | 4.05 | 0.78 | 0.269 GB (measured, P4 manifest) |
| `2h` | 572,068 | 0.118 | 2.40 | 4.20 | 0.50 | ~0.17 GB |
| `4h` | 336,795 | 0.070 | 1.44 | 4.29 | 0.30 | ~0.10 GB |
| `1d` | 66,226 | 0.014 | 0.36 | 5.37 | 0.074 | 0.026 GB (measured) |

How the history column is derived: B/ride × 330 M rides × 1.04. The ride count is 325.6 M from 2013-06-01 to 2026-08-05, the sum of `count_n` over the `rides-tl/start/1d` shards, rounded up to the end of August. The 1.04 factor is measured/extrapolated at `1h`: 269 MB actual vs 0.78 × 330 M = 257 MB. Winter months have sparser bins, so they have more rows per ride. At `1d` the same factor is 1.07.

Rows/ride at a given bin is **stable across eras**. At `1m` it is 0.861 (2015-06), 0.851 (2019-06) and 0.873 (2025-06); at `1h` it is 0.166, 0.176 and 0.193. The station count grew with ridership, so a station-minute is about as sparse in 2015 as in 2025.

### The key insight: below ~15 min, rows ≈ rides

At `1m`, 87% of rows hold exactly one ride. Summing to `5m` removes only 26% of rows, and bytes drop by only 14%. Each fine tier therefore costs about the raw ride count, ≈0.5–0.8 GB/anchor for the full history, and adjacent fine tiers are nearly redundant. Serving a bin from a finer tier costs this many times the bytes of a dedicated tier:

| serve | from | cost multiple |
|---|---|---|
| `5m` | `1m` | 2.28 / 1.96 = **1.16×** |
| `10m` | `1m` | 1.35× |
| `15m` | `1m` | 1.53× |
| `30m` | `15m` | 1.37× |
| `2h` | `1h` | 1.56× |
| `4h` | `1h` | 2.6×, but only ~0.3 B/ride × a chunk (tens of KB) |

## Tier ladder

**Proposed: add `1m` (new base) and `15m`**. `5m` and `30m` are optional cost knobs: each is a config line plus a fill-mode build later if profiles call for it. There will be no `2h`/`4h`: `3h`/`6h` already exist, and summing `1h` serves the rest at chunk sizes of tens of KB.

```yaml
tiers:
  - { name: 1m,  bin: 1min,  shards: [6h, 12h, 1d, 2d, 4d] }     # base (ingest truncates to 1min)
  - { name: 15m, bin: 15min, shards: [1d, 2d, 4d, 8d, 16d] }
  - { name: 1h,  bin: 1h,    shards: [1d, 2d, 4d, 8d, 16d, 32d] }  # unchanged
  # … 3h … 1y unchanged
```

Cascade edges: `15m ← 1m`, `1h ← 15m`, then the existing `3h ← 1h` and so on. Every source bin divides its target (`1min | 15min | 1h`), so the planner's `source_bin | target_bin` check holds. With `5m`/`30m` added, the edges become `1m → 5m → 15m → 30m → 1h`. Tier names follow the avail configs (`1m` name, `1min` bin, since `1mo` is the month).

**Shard rungs deviate from the ≈1k-bins rule, deliberately.** The rule would give `1m@16h` (960 bins) and `15m@8d` (768). That rule sizes *station-first* shards, where a read touches every bin of a station. Time-first reads touch only the chunk's row groups (`dt` RG pruning, confirmed in P0), so for `rides-tl` a shard's span sets only three things: object count, footer size and fill granularity. Object count is what hurts here. `1m@12h` means ~9.7 k max-shards per anchor (4,840 days × 2), which is ~2.9 MB of `manifest.jsonl` that `/api/tl` fetches and parses per isolate every 60 s (it is 275 lines today). Sizing by bytes instead:

- `1m@4d`: June 2025 is 4.22 M rows / 30 d × 4 = 563 k rows, 17 RGs, ~1.5 MB, footer ~7 KB. That is ~1.2 k max-shards per anchor. This rung is also allowed in avail's `1m` tier, which already runs `1d`/`2d` rungs through the lambda path.
- `15m@16d`: 1.1 M rows, 34 RGs, ~3.9 MB. That is ~300 shards per anchor, comparable to `1h@32d` (3.2 MB).

The rungs are powers of 2 in days (plus `6h`/`12h` for `1m`'s tip), so monthly fills consolidate tip dust as the existing tiers do.

### Build cost

- **R2**: +1.29 GB/anchor (`1m` 0.78 + `15m` 0.51), so +2.6 GB for both anchors, on top of today's 1.16 GB. Adding `5m`+`30m` would bring it to +4.7 GB. At $0.015/GB-mo that is ~$0.04–0.07/mo. Class-A puts: ~3 k objects, which is pennies.
- **Batch**: P4 built the full history in ~20 min wall per anchor, including Spot startup, and wrote 581 MB. Ingest reads the same 330 M rides either way. The group-by at `1m` emits ~4.5× the rows of `1h`, and the output grows ~3.2×, so the estimate is **30–45 min per anchor, < $5 total**. This is extrapolated, not measured; F1's one-month scratch build measures it.

### Source change

`MonthlyRidesSource` hardcodes `.dt.truncate('1h')` (`rides_source.py:255`). It should truncate to the config's finest tier bin instead: read `pyramid.tiers[0].bin`, and fail if a coarser tier is declared first. Nothing else changes.

## Any bin by serve-time summing

### Allowed bins

- **Fixed**: `b` = n minutes where `b | 1d` (1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30, 40, 45, 48, 60, 72, 80, 90, 96, 120, … 720, 1440 min), or `b` = a whole number of days. `7m` or `5h` would make frames straddle midnight irregularly, and the clock would read nonsense, so they are rejected with a 400.
- **Calendar**: `Nmo` with `N | 12` (1, 2, 3, 4, 6, 12). `1y` ≡ `12mo`.
- Parsing: `/^(\d+)(m|min|h|d|mo|y)$/`, normalized to canonical codes (`90m` → `90m`, `60m` → `1h`, `24h` → `1d`). The canonical code is part of the cache key.

### Source tier

The source is the coarsest built tier `t` with `t | b` and `t ≤ b`. Fixed tiers are epoch-aligned, so divisibility implies nesting. For calendar bins, only tiers dividing a day qualify (as `finerTiers('1mo')` does today). Examples with the proposed ladder: `20m` → `1m`; `45m` → `15m`; `2h`/`4h`/`8h` → `1h`; `2d`/`10d` → `1d`; `21d` → `7d`; `4mo` → `1mo`. The min-cover's tip keeps falling back to finer divisors exactly as `planCover` does now. The source tier is an implementation detail and **never appears in the response's cache identity**, because the sums are exact whichever tier serves them.

### Frame grid and origin

The rule generalizes today's: `span(b) = K(b)·b`, and `origin(b) = floor(GENESIS / span(b)) · span(b)`, epoch-aligned for fixed bins and on a year-0 month grid for `Nmo`. Chunk `k` is frames `[k·K, (k+1)·K)`. Because `b | span`, frames lie on the epoch-aligned `b` grid. For built tiers the chosen spans are also shard rungs, so a chunk is usually one shard. For derived bins that doesn't matter, because RG pruning makes any span a contiguous read. One inherited quirk: epoch-aligned `7d` frames start on Thursdays (1970-01-01). A Monday-start week is an open question.

### Chunk size K (target bytes per chunk)

`K` must be a pure function of `b`, because it is part of what a chunk URL means. Target: ≤ **100 k rows per chunk at peak density** (200 k rides/day; the peak day is 208,126 on 2026-06-03). Today's `1h` chunk is 48 × ~1.5 k = 72 k rows, 64 KB gzip. So:

- `estRowsPerDay(b) = min(2,500 × 1d/b, 200 k × r(b))`, with `r(b)` log-interpolated from the rows/ride column above.
- Sub-day `b`: `span(b)` = the largest value in `[6h, 12h, 1d, 2d, 4d, 8d, 16d, 32d]` with `b | span` and `estRowsPerDay(b) × span ≤ 100 k`.
- `b ≥ 1d`: `K = 32` (rows/frame saturate at the ~2.4 k live stations). `Nmo`: `K = 24 / N`, rounded up to at least 2, so `1mo` stays 24 as today.

| bin | span | K | est. rows/chunk | notes |
|---|---|---|---|---|
| `1m` | 12h | 720 | 87 k | measured on 2025-06-04 00–12h: 53 k nnz, 93 KB gz (CSR) |
| `5m` | 12h | 144 | 65 k | |
| `15m` | 1d | 96 | 86 k | measured: 75 k nnz, 75–107 KB gz |
| `30m` | 1d | 48 | 60 k | |
| `1h` | 2d | 48 | 76 k | unchanged; measured 65 k nnz, 64 KB gz |
| `3h` / `6h` / `12h` | 4d / 8d / 16d | 32 | 70–80 k | unchanged |
| `1d` … `14d` | 32·b | 32 | ~77 k | unchanged |

### Response encoding: dense vs CSR

At `1m`, a chunk is **3–5% dense** (53 k nonzeros in a 720 × 2,161 grid). The dense `counts[f·S+s]` array becomes 3.1 MB of raw JSON (6.4 MB for a full day), even though gzip hides it on the wire (90 KB vs CSR's 93 KB). What that costs is parse time and memory in both the worker and the browser. So the worker picks the format by density. Below 0.25 it emits `fmt: "csr"`: `{ptr: [K+1], idx: [...], val: [...]}`, which is 376 KB raw for the same chunk. Otherwise it emits today's dense `counts`. The FE handles both; `frameSlice` becomes a small interface over the two.

### Cache keys and immutability

- The URL is `/api/tl?anchor=&bin=<canonical>&chunk=<k>&gv=1[&raw=1]`. `gv` is the grid version, covering the `K(b)`/origin rules. The worker 400s on a `gv` it doesn't implement, so a rule change can't make an immutable URL mean a different time range. The edge key keeps `RIDES_CACHE_GEN` + `TL_PREFIX`.
- **Immutable** once `t1 ≤ finalThrough(anchor)`. `finalThrough(end)` is the end of the latest ingested month; `finalThrough(start)` is the first day of the latest ingested source month. The whole newest start month remains mutable: measured rides last up to 94 hours, and the next month's parquet can add starts more than one day before month-end. Today's rule ("every read came from the requested tier") can't apply to derived bins. It was a proxy for finality anyway, since tip het-tiling from finer tiers gives exact sums. `rides-tl-extend` writes the watermark (`rides-tl/{anchor}/final.json`) after its fills succeed.
- Otherwise the chunk gets `max-age=3600`, as today.

### FE mirror

`timelapseFrames.ts` gains the same pure functions (`parseBin`, `canonBin`, `spanOf`, `K`, `originMs`, `frameOf`, `frameStartMs`) in place of the `TL_K` table and the `'1h' | '1d'` `Bin` type. To keep the worker and FE from drifting, both import one module, `www/src/lib/tlGrid.ts`. The pure shared module lives inside the website Docker context; the Worker imports it from the same checkout. The GBFS deploy path filter watches this source too. A golden-vector test (`tlGrid.test.ts`: bin → canonical, K, origin, frame/chunk of a few instants, including DST days and `4mo`) runs in both packages.

## Sliding window

Frames step every `b`, e.g. `1m`, and each frame shows the trailing `w` (`w = W·b`), so a 1-ride station-minute doesn't twinkle, and net flow `(S−E)/(S+E+k)` is computed over enough rides to mean something.

- **Value at frame `i`**: `Σ_{j=i−W+1..i} v_j`, per station and anchor. It is kept as a running `Float32Array(S)`: stepping forward adds frame `i` and subtracts frame `i−W`, so each step costs O(nnz of two frames), ~200 entries at `1m`. A seek recomputes from scratch in O(W × nnz), which is trivial.
- **Kernel**: box by default. `wk=tri` (triangular weights) is an option that softens the moment a ride leaves the window.
- **Scale**: a `w`-window sum has the same distribution as a `w`-bin frame, so the global per-bin scale (`tl-scale` p99) is looked up at `w`, not `b`. The map stops "breathing" when `b` changes.
- **Clock**: "Tue Jun 10 · 08:31 (last 30m)". The label shows the window end.
- **Chunk prefetch**: the window at frame `i` needs chunk `k−1`'s tail whenever `i mod K < W−1`. The constraint `w ≤ span(b)`, i.e. `W ≤ K`, means at most one previous chunk is needed. `windowReady(i)` = chunk `k` cached, and (`i mod K ≥ W−1` or chunk `k−1` cached). Forward playback already holds `k−1`. A seek or scrub fetches `k` first, then `k−1`. At range start the window pre-rolls into frames before the range, fetched the same way. Before genesis the values are zeros.
- **Interaction with any-bin**: `b` is the step and is served by summing, as above. `w` is only a browser-side sum, so `b=5m&w=1h` reads `1m` shards summed to `5m` on the worker, then summed ×12 in the browser.
- The sub-bin `fpb` lerp still works: it interpolates between adjacent window sums.

## Four linked controls: bin, fps, range, length

Invariant: `frames = range / bin` and `length = frames / fps`, so **`range = bin · fps · length`**. The user can set any of the four. The least-recently-set of the other three is recomputed, as in mortgage-viz's `~/c/rac/mortgage-viz/src/lib/model.ts`, where the oldest user-set field in an overdetermined constraint is derived, and `derive()` doesn't refresh a field's recency.

### `lruConstraints.ts` (generic, `www/src/lib/`)

Monomial constraints `Π xᵢ^aᵢ = c` are linear in log space (`Σ aᵢ log xᵢ = log c`). With `m` constraints, the solver picks the `m` least-recently-set variables whose columns are linearly independent (greedy LRU order with a rank check) and solves the linear system. For ctbk, `m = 1`: `log R − log b − log f − log L = 0`.

```ts
type Domain =
  | { kind: 'continuous', min?: number, max?: number, absorb: true }   // may hold any value in range
  | { kind: 'discrete', values: readonly number[] }                    // snap: nearest in log space
  | { kind: 'step', step: number, min?: number, max?: number }         // whole days, whole frames …
interface VarSpec<K extends string> { name: K, domain: Domain }
interface Monomial<K extends string> { exps: Partial<Record<K, number>>, c?: number }

class LruSystem<K extends string> {
  constructor(vars: VarSpec<K>[], constraints: Monomial<K>[], init: Record<K, number>, order: K[])  // order: oldest first
  set(name: K, value: number): Record<K, number>   // snaps `value`, touches `name`, re-solves
  values(): Record<K, number>
  order(): K[]                                      // for URL persistence
  derived(): Set<K>
}
```

**Snapping, and absorbing the rounding error.** After `set(x)`, walk the other variables oldest first. Solve the next one, `y`, exactly, then snap it to its domain. If the snap is within tolerance (1e-9 in log space), stop. Otherwise fix `y` at the snapped value and move to the next-oldest variable. The walk ends at the first variable whose domain is `absorb: true`, which takes the exact value. ctbk's domains:

- `b`: discrete (the curated bin list, and only bins that are legal for the range).
- `R`: step 1 day, or 1 frame when `b > 1d`. It is clamped to `[genesis, latestFinal]`, keeping the start and moving the end (the start moves only if the end hits the data edge).
- `f`: continuous, absorbing, in `[0.25, 60]`. rAF advances `t` continuously, so 2.8 fps is real, and above 60 fps is just skipping frames.
- `L`: continuous, absorbing, ≥ 1 s.

There are always ≥ 2 absorbers, so the walk always terminates exactly, whichever variable was set.

The default order, oldest first, is `[L, f, R, b]`. Changing the bin, the range or the fps therefore changes the length, and setting the length changes the fps. That matches today's behaviour until the user touches `len`.

### UI, URL

- The ⚙ panel gets four fields: **bin** (select plus free text), **fps** (number with `[`/`]` steps), **range** (the existing `d`), **length** (`m:ss`). Derived fields render in italic with a "derived" rTT. Clicking one makes it user-set.
- URL: `b` (now any canonical bin), `sp` (now a float, e.g. `2.8`), `d`, and **`len=`** (seconds, or `1m30s`), plus `w=` (window, default `= b`) and `wk=`. Only user-set variables are written. `len` is written only once the user sets it. `lru=` (e.g. `lru=Lfdb`, oldest first) is written only when the order differs from the default, so a shared link reproduces the same "what moves next" behaviour.

### Tests (`lruConstraints.test.ts`, exact equality)

1. Init `b=1h, R=7d, f=8`, default order → `L = 168/8 = 21` s.
2. `set(L, 60)` → `f = 168/60 = 2.8`; order `[f, R, b, L]`.
3. Then `set(b, 15m)` → `f = 672/60 = 11.2` (`f` still oldest).
4. Then `set(R, 90d)` (order `[f, L, b, R]`) → `f = 8640/60 = 144`, which clamps to 60 (off-domain), so `f` is fixed there and the walk moves on. The next-oldest variable, `L`, absorbs: `L = 8640/60 = 144` s.
5. `set(L, 50)` with order `[R, f, b, L]` and `b=1h, f=8` → `R = 400h = 16.67d`, which snaps to 17d. The next variable, `f`, absorbs: `f = 408/50 = 8.16`.
6. Log-space solver: a 2-constraint synthetic system with a rank-deficient LRU pair, checking that the solver skips to the next independent variable.
7. `R` clamping at the data edge moves the start, not the length.

### Extraction path

mortgage-viz's constraints are not all monomial. The purchase triangle `P = D + L` is linear. PMT, `M = P·r(1+r)ⁿ/((1+r)ⁿ−1)`, is transcendental in `r`, and `model.ts` simply skips deriving `annualRate` ("Could implement Newton-Raphson later"). A standalone library therefore needs a per-constraint `solve(var, known) → number` interface. Monomials implement it in closed form. Other constraints get a bracketed Newton/bisection fallback over the variable's domain. The path:

- (a) ship monomial-only in ctbk;
- (b) generalize to `Constraint { vars; solve(v, known) }`, keeping the monomial helper and adding a numeric fallback;
- (c) publish it as an npm package (with the `use-prms` binding as an optional helper), and port mortgage-viz to it, which fixes its `annualRate` gap.

## Phases

F1 implementation: `MonthlyRidesSource` truncates to the first/finest configured tier, with pyrmts minute units translated for Polars. Separate `rides-tl-fine-{start,end}` configs preserve the existing serving prefix and monthly cadence during validation. Source tests cover both anchors at minute and quarter-hour boundaries, exact hourly parity, and candidate Batch factory/sort selection; the full pyramid suite passes (104 tests). The first candidate build covers June 2025 at `rides-tl-f1/{start,end}`. Image/build identifiers and measured gates will be recorded here before adoption.

June 2025 F1 gates passed for both anchors on 2026-10-11. Image `ctbk-engine:789dc78a`, HCCS Batch revision 10; start job `49183149-139c-4073-8bf3-b12ba54f5588`, end job `e7dced3c-6dbc-408e-91cf-b0e862622899`, both succeeded. `ctbk gbfs engine tl-check -c rides-tl-f1 -r 2025-06-01/2025-07-01` verifies all three count-monoid columns over exact manifest-selected covers: minute→hour, quarter-hour→hour, and candidate hourly→production hourly all equal for every cell-hour. Actual bytes are approximately 11.1 MB (`1m`) and 7.2 MB (`15m`) per anchor, within the ±20% budget. Immutable input shards are cached under `tmp/tl-check` for repeatability; the report is in root `tmp/fine-parity.json`. Full-history builds remain at the candidate `rides-tl-fine` prefix, capped at 2026-10-01, until full validation and serving adoption.

- **F1: config + source + scratch build** (Batch, authorized with the full roadmap). Truncate to the base-tier bin; `1m`/`15m` tiers with the rungs above; a one-month scratch build (2025-06, `rides-tl-f1/`). Gates:
  - `1h` cascaded from `15m` equals the existing P4 `1h` shards row for row (ideally md5-equal);
  - Σ `1m` per hour equals `1h` on every station-hour;
  - measured bytes are within ±20% of the table.

  Then the full-history build and `rides-tl-extend` picking up the new tiers.
- **F2: `/api/tl` any bin**. `www/src/lib/tlGrid.ts` (parse/canon/span/K/origin plus golden vectors), source-tier selection, CSR encoding, `gv`, the `final.json` watermark, and e2e checks: `20m` = Σ of `1m` ×20, and `45m` = `15m` ×3, compared against built tiers.
- **F3: FE bin picker + window**. `Bin` becomes a string code, plus `w`/`wk`, the running-sum window, `windowReady`-aware prefetch, and the CSR reader.
- **F4: LRU controls**. `lruConstraints.ts` with tests, the four-field panel, `len`/`lru` params, and movie mode taking `len` to set the frame count.

## Open questions

- Is `5m` worth 0.67 GB/anchor when serving it from `1m` costs 1.16×? Default no; revisit if the worker's CPU for a `1m` → `5m` sum (≤ 100 k rows/chunk) shows up in profiles.
- Should the manifest be split per tier (`manifest/{tier}.jsonl`) instead of (or as well as) byte-sized rungs? That would make the ≈1k-bins rule affordable again, if any consumer still wants it.
- Monday-aligned weeks: an origin offset for `Nd` bins with `7 | N`, or keep epoch Thursdays.
- DST: a `1m` bin inherits the local-time quirks. The fall-back hour sums two real hours into one set of 60 bins. Is a "DST" badge on those frames enough?
- Should `w` also accept non-multiples of `b` (e.g. `b=15m`, `w=20m`) via fractional edge weights? Default no.

[`timelapse-map.md`]: timelapse-map.md
[`rides-tl-start.yaml`]: ../configs/pyramids/rides-tl-start.yaml

Full-history candidate jobs: start `6e8e891d-ea69-4728-a74a-dc89fb09e96f`, end `f26efd86-9a55-44f9-bbb1-83dfd675f55d` (8 vCPU / 32 GiB each, image `789dc78a`, cap 2026-10-01). F2 grid and CSR serving are implemented behind `gv=1`; legacy grid ranges are preserved. Sparse responses accumulate directly without a dense minute matrix. A derived frame is covered only when its whole interval is available. API validation: 301 tests and TypeScript passed; client: 139 tests and TypeScript passed. Watermark publication and fine-prefix serving adoption remain pending.

Monthly cadence repairs the previous start month through the invalidation journal before filling. `ctbk gbfs engine tl-finalize [-F] YM` verifies continuous hourly and minute coverage for both anchors before publishing watermarks; `rides-tl-extend` calls it only after both jobs succeed. Fine cadence is the default; `-F` selects legacy hourly cadence.

Full-history gates passed for all 160 months, June 2013 through September 2026, on both anchors. Every cell-hour and all three sum-monoid columns equal the hourly baseline. Totals: 335,007,625 starts and 335,009,585 ends. End job `f26efd86-9a55-44f9-bbb1-83dfd675f55d` was interrupted by Spot eviction; fill retry `c2737ca8-2f8c-42c4-808f-6aac2ea2275c` succeeded. Start job `6e8e891d-ea69-4728-a74a-dc89fb09e96f` succeeded. Reports: root `tmp/fine-full-{start,end}-parity.json`. Watermarks are published: start 2026-09-01; end 2026-10-01. API configuration adopts `rides-tl-fine` and monthly cadence defaults to it (`-F` explicitly selects legacy hourly).

F3/F4 now include preset and custom nesting bins, minute deep links, box/triangle trailing sums with genesis pre-roll, window-based scale, fractional fps, movie length, persisted LRU order, derived-field styling, and recency on focusing fields. Fixed/calendar range edges are handled in `timelapseLinked.ts`; the monomial solver is generic and skips rank-deficient variable sets. Versioned missing data never falls back to synthetic counts; pre-genesis time is known zero, including the first partial calendar year. Seven focused browser tests pass; desktop and phone/window edits were checked in HCCSx Chrome. Real SNAPPY parquet fixtures verify 20-minute and 45-minute aggregation, CSR payloads, complete coverage, and finality cache headers. Windows currently use the same legal codes as bins; calendar windows that do not divide one year are not accepted.

Deployment `cb4710bc` passed website (`38191906841`), worker (`38191906830`), and Python (`38191906777`) CI. HCCSx live Chrome verified minute data and a two-hour trailing window: June 10 at 13:31 shows 6,462 starts; changing from 15-minute to minute bins while holding 60 seconds derives 24 bins/second. Screenshot: root `tmp/tl-fine-live-minute.jpg`.

Movie capture samples the interactive bins/second clock at `cfps` (default 30), so its frame count is `ceil(nBins * cfps / sp)` and its duration agrees with linked controls to one capture frame. Explicit `fpb` presets retain their fixed samples per bin. `window.__tl` publishes `frames`, `fps`, and `seconds`; `seek` waits for trailing-window data as well as deck redraw and map idle. `pnpm render:tl --fps 30 URL OUTPUT.mp4` probes those values and renders through scrns, writing a JSON manifest beside the video. Validation: 153 unit tests, TypeScript, eight focused browser tests, and a real 480×480 smoke render with 24 visible frames at 12 fps; ffprobe reports exactly 2.000000 seconds. Artifact: `www/tmp/movies/linked-smoke.mp4`.
