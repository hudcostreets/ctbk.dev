# avail-v5: engine-backfilled, Lambda-maintained successor stack

Status: **in flight** (2026-07-28). Stand up `avail-v5/` as a fully separate pyramid stack — Batch-engine backfill + minutely cascade-Lambda tick — burn it in alongside the serving stack, then cut the FE/BE over via the D1 registry (pyramid-name flip). Rollback = flip back.

## Why / context

- The pyrmts-engine Batch path is proven (2026-07-23, `avail-v4-engine-check/`): full-range build in ~34 min / ~$2 on Fargate Spot ARM (16 vCPU / 48 GiB, `-w 1h -b 24g -C 3 -c 2g`), content ≡ the v4 fan-out 99/99 shards, byte-deterministic across runs in-environment (manifest `md5`/`bytes` diff). See pyrmts `specs/engine-e-iteration.md` for the executor iteration that got it there.
- `avail-v4/` turned out to be **dormant since 2026-07-18T22**: the minutely EventBridge rule invokes `ctbk-avail-cascade` with no payload → handler default `avail` (v3). v4 was only ever ticked manually (the drop-LUC `#161` "tick flip" never happened). FE/BE serve v3. So v5 supersedes the half-migrated v4; the eventual cutover is v3 → v5, and v4 becomes deletable after.
- Steady-state updates are the **existing cascade Lambda** (declarative gap discovery + same-tier consolidation + raw vocab-chain ingest of the 1m base tier; self-healing across timeouts via per-shard commits). The engine stays the backfill/rebuild tool; engine-side consolidation / min-cover source / raw-ingest are future pyrmts work, not blockers.

## Components

| piece | what |
|---|---|
| `configs/pyramids/avail-v5.yaml` | identical ladder/metrics/vocab to v4, re-keyed `avail-v5/` |
| 1m seed | `ctbk gbfs r2 cp -r avail-v4/1m avail-v5/1m` — 264 server-side copies (2d rung genesis→07-16 + 12h/1h/… tip through 07-18T22); v4's 1m tier is the piggybacked source until engine raw-ingest lands |
| config upload | `ctbk gbfs engine config -R -C avail-v5 -u` → `avail-v5/config.yaml` (merged ladder at its own real prefix; `-R` refused for the live-serving `avail`) |
| Batch backfill | `ctbk gbfs engine submit -C avail-v5 -p avail-v5 -r 2026-04-07T01:15/2026-07-18T00:00 -w 1h -b 24g -k 3 -c 2g -V 16 -M 49152 -m manifest-backfill.jsonl -W` (range end = last complete `1m@2d` source shard) |
| D1 registration | `ctbk gbfs engine register s3://ctbk/avail-v5/manifest-backfill.jsonl` (engine shards) + one-off SQL copying v4's 60 registered 1m rows re-keyed to v5 (registry = serving min-cover; unregistered R2 residue is harmless) |
| v5 tick | `gbfs/lambda/deploy.py -5`: `ctbk-avail-cascade-v5` (same zip/handler, reserved=1) + rule `ctbk-avail-cascade-v5-tick` `cron(3/5 …)` with Input `{"config": "avail-v5"}` (+3-min phase offset from the v3 tick) |

## Burn-in

- First ticks face a ~10-day gap (07-18 → now): 1m raw ingest from vocab chains + all coarser tiers from 1m. The declarative contract converges over successive 12-min-budget ticks — deliberately exercised as part of burn-in. (Acceleration lever if needed: the `ctbk-avail-rebuild` fan-out — requires a full `deploy.py` run so its zip gains `avail-v5.yaml`.)
- Watch: `ctbk gbfs lambda logs -f ctbk-avail-cascade-v5`; freshness = max registered `period_end` for `pyramid='avail-v5'` vs now; daily `ctbk gbfs engine compare` (v5 content vs v4/v3 over the overlapping range).
- Cutover (after burn-in): point the api worker at `avail-v5` (prefix + registry pyramid name — the drop-LUC `#161` worker-read-path phase, retargeted at v5). v3 stack untouched as rollback. Then: retire v4 objects, and eventually the v3 tick's upper tiers once v5 is authoritative.

## Deferred / follow-ups

- pyrmts engine: same-tier consolidation (Lambda-safe incremental), min-cover (multi-rung) source, raw-ingest source (retires the WAL→1m piggyback), `batch push` Dockerfile default (`python/pyrmts_engine/Dockerfile`).
- Writer-version pinning: canonical bytes are defined by the builder image (pyarrow 25.0.0 in `pyrmts-engine:4865a58`); venv builds differ in footer bytes only.
- `avail-v4-engine-check/` scratch: delete shards+seeds, keep manifests (proof provenance).
