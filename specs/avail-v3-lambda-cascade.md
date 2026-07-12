# avail-v3: Lambda cascade (one executor for all rungs)

## Goal

Replace the CFW cascade worker (`gbfs/cascade`) with a single AWS
Lambda running Python + pyrmts-py + pyarrow — the code path that built
the entire historical pyramid without incident. Two phases:

- **P1**: Lambda owns rungs *above* the current ladder maxima (the
  N>960 extension — `1d`+ tiles at fine tiers, month/quarter-scale
  tiles at coarse tiers) plus the GC sweep. CFW unchanged.
- **P2** (quick succession): Lambda takes over every rung on a
  minutely schedule; CFW cascade cron disabled, worker retired.

The api worker (`gbfs/api`) stays on Cloudflare — serving wants edge
cache + colo-local R2 reads. Only the *write* side moves.

## Why

Every production incident in the cascade's short life traces to a CFW
constraint or to complexity added to live within one:

| incident | CFW constraint behind it |
|---|---|
| multipart 10048 crash (2026-07-10) | 128 MB isolate → streaming multipart writer |
| `statistics: false` full-scan reads | same writer stack (hyparquet-writer TS) |
| `MAX_SOURCE_BYTES` wedge on `/2m@1d` (07-11/07-12) | 30 s CPU → byte/row/tile guards |
| `MAX_TILES` fragmentation abort | same |
| `MAX_RAW_FILL_MIN` raw-fill cap | same |
| N ≤ 960 ladder cap (no `1d`+ rungs at fine tiers) | same |
| GC losing to dust (~1.3k new/day vs ~350 deleted/day) | 25 s budget per daily cron |
| time-budgeted ticks (7 rungs/tick during recovery) | 30 s CPU |

Lambda budget: 10 GB RAM, 10 GB `/tmp`, 15 min wall. At the cascade's
actual load — amortized **~0.9 writes/min** (54/hour; a typical UTC
midnight closes 53 rungs, worst epoch boundary 120) with ~5 raw GETs +
~10-20 HEAD probes per tick — none of the guards above are needed:
buffer whole shards in RAM, single `PutObject` (no multipart), pyarrow
stats for free, GC drains any backlog in one invocation.

Cost of leaving CF for writes: public-internet RTTs to R2 (~30-60 ms/op
from us-east-1 → ~1-3 s/invocation wall at the op counts above) and a
second cloud's deploy story (precedent: `$c/awair` already runs a
Lambda on pyrmts). Both acceptable.

## Architecture

```
EventBridge schedule ──► Lambda (container image)
                           │  ctbk.pyramid_cascade converge()
                           │  + gc sweep
                           ├── R2 via boto3 S3-compat (R2_* keys)
                           └── D1 via CF REST API   (shard registry)
```

- **Runtime**: Python 3.12, zip package + the AWS-managed
  `AWSSDKPandas-Python312` layer (provides pandas/pyarrow/numpy —
  awair's exact pattern, no container image needed). CDK app under
  `gbfs/lambda/` mirroring `awair/src/awair/lmbda/app.py`
  (`reserved_concurrent_executions=1`, EventBridge rate rule).
- **Code**: handler over the existing `ctbk/pyramid_cascade/` fsck
  machinery (discover gaps vs the extended ladder → materialize →
  register). ONE new piece of cascade logic: an accumulator-based
  per-shard materializer. The existing `materialize_shard` explodes
  sources into a per-state polars long-frame — O(bins × cells ×
  metrics × states) ≈ **17 GB peak at N=1440** (`/2m@2d`), which
  exceeds Lambda's 10 GB for exactly the extension shards P1 exists
  to build. The `engine_streaming.py` accumulator pattern runs
  ~375 B/output-row (~750 MB peak on full rebuilds); scoped per-shard
  it handles N=4096 in ~6 GB. Extension rungs therefore cap at
  **N ≤ 4096** (revised from the ≤8192 sketch below).
- **Config**: `configs/pyramids/avail.yaml` stays the single source of
  truth. Rung→executor split expressed as a per-tier
  `lambdaShards: [...]` extension list (P1) so the CFW's view of
  `shards` is unchanged; P2 collapses the split (CFW retired).
- **Secrets**: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
  `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` (D1 query scope) as
  Lambda env vars (or Secrets Manager if preferred).
- **D1 registry**: `POST /client/v4/accounts/{acct}/d1/database/{id}/query`.
  Same `pyramid_shards` rows the CFW writes today; /health and the read
  planner are executor-agnostic (they only look at D1 + R2), so they
  work unchanged through both phases.
- **Observability**: CloudWatch logs; /health already covers pyramid
  state and the existing Slack alert rules fire off it. Optionally a
  Slack post on Lambda error (CloudWatch alarm → SNS) later.

## Ladder extension (P1 scope)

Extend each tier a few rungs past its current max, keeping the
divisibility chains (base-60 below 1d, powers-of-2 above). Cap by
*rows* now that the executor allows it — target ≤ ~50M rows/shard
(≈ 25× the `/1m@12h` = 2.79M-row unit, minutes of pyarrow work):

Expressed as per-tier `lambda_shards` lists in `avail.yaml` (the CFW
reads only `shards`, so its view is unchanged in P1). All N ≤ 4,096:

| tier | today's max (N) | `lambda_shards` | new max N |
|---|---|---|---|
| 1m  | 12h (720)  | 1d, 2d            | 2,880 |
| 2m  | 1d (720)   | 2d, 4d            | 2,880 |
| 3m  | 2d (960)   | 4d, 8d            | 3,840 |
| 5m  | 2d (576)   | 4d, 8d            | 2,304 |
| 10m | 4d (576)   | 8d, 16d           | 2,304 |
| 15m | 8d (768)   | 16d, 32d          | 3,072 |
| 30m | 16d (768)  | 32d, 64d          | 3,072 |
| 1h  | 32d (768)  | 64d, 128d         | 3,072 |
| 2h  | 64d (768)  | 128d, 256d        | 3,072 |
| 3h  | 64d (512)  | 128d, 256d, 512d  | 4,096 |
| 6h  | 128d (512) | 256d, 512d, 1024d | 4,096 |
| 12h | 256d (512) | 512d, 1024d, 2048d| 4,096 |
| 1d  | 512d (512) | 1024d, 2048d      | 2,048 |
| 3d  | 1536d (512)| 3072d             | 1,024 |
| 7d  | 3584d (512)| 7168d             | 1,024 |

Coarse-tier extensions matter most for wide-query plan size — this is
what retires the relics: real `16d`/`32d`/… rungs supersede the old
pow2 tiles, making them GC-able under the normal covering-parent
gate. Rungs whose duration exceeds all history collapse to a single
whole-history trailing tile per tier (the useful behavior the old
`120y` tiles approximated).

Backfill: closed history at the new rungs is built by the Lambda's
first invocations (fsck-style: plan missing → write). ~2 rungs/tier ×
~90 days of history ≈ low hundreds of shards, minutes-to-hours of
Lambda time, one-time.

## GC in the Lambda

Port `gcSweep` semantics (15-min grace; same-tier covering parent
HEAD-verified on R2; raw WAL prefix never eligible) to Python with a
budget that actually clears the backlog (one invocation ≫ daily
production of ~1.3k stale/day).

**Sequencing matters**: GC's eligibility test and /health's missing
test both derive from "expected cover", and the extended ladder
changes what that is. Under the extended ladder, today's max-rung
tiles (e.g. `/1m@12h` over closed history) leave the expected cover
(superseded by `1d`/`2d` tiles) and become GC-eligible — but the api
worker's health config must adopt the extended ladder FIRST, or
health shows red for every tile GC removes. Order: (1) Lambda deploys
with `GC_ENABLED=0` (fill-only), (2) extension backfill converges,
(3) api worker health config adopts the extended ladder (stays green
— extensions exist), (4) `GC_ENABLED=1` with the extended config; the
CFW's 06:05 GC branch is removed in the same window. Old sub-max
tiles and the pow2 relics then drain through the normal
covering-parent gate.

Relic cleanup: once extended rungs land, the old off-ladder tiles
(4d/8d/16d pow2 relics, 120y whole-history tiles) acquire covering
parents and age out through the normal gate — no special mode needed.

## Phases

**P1 — extension rungs + GC** (CFW untouched):
1. `gbfs/lambda/`: handler + Dockerfile + GHA build/deploy workflow.
2. `avail.yaml`: add `lambdaShards` per tier (table above).
3. Wire D1 REST registration into the Python cascade (it currently
   shells out to wrangler; add an HTTP fallback used in-Lambda).
4. EventBridge: `rate(1 hour)` — extension rungs close at ≥1d
   boundaries; hourly gives fast self-heal without waste.
5. Remove the CFW 06:05 GC branch (one-line; batched with next
   cascade deploy).
6. Deploy → watch first invocations backfill history at the new
   rungs → /health shows the extended expected covers converging →
   relics age out.

**P2 — full takeover** (target: days after P1 is stable):
1. Extend the Lambda's remit to all rungs (drop the split; its
   converge() plans the whole ladder incl. raw→/1m ingest).
2. EventBridge → `rate(1 minute)`.
3. Disable the CFW cascade cron (`crons = []`), leave the worker
   deployed-but-idle for a revert window, then delete `gbfs/cascade`.
4. Watch a midnight + a 12:00 boundary; confirm allComplete holds and
   p99 shard lag (period_end → written_at) is ≤ a few minutes.

Rollback at any point: re-enable the CFW cron — the pyramid is
self-healing from either side, and both executors write the same keys
from the same config.

## Open questions

- ECR/IAM bootstrap: reuse awair's account/role patterns? (Owner
  call — whichever account the awair Lambda lives in, or a ctbk one.)
- Minutely-cadence freshness in P2: the CFW tick currently lands /1m
  dust ~seconds after each 5-min boundary; Lambda cold starts
  (~1 s container) + cron jitter put worst-case shard lag around
  a minute — acceptable for a chart whose finest live bin is 1 min?
  (The live edge is also served from raw WAL directly, so chart
  freshness may not depend on cascade lag at all — verify during P2.)
- Whether to fold `compact-r2.py` (the GHA daily WAL compactor) into
  the same Lambda later. Out of scope for P1/P2.
