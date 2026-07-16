"""Fan-out bulk rebuilds via single-gap Lambda invocations.

`specs/avail-v3-lambda-rebuild.md`: stale-content re-keys (e.g. a
station-luc denorm change) invalidate every shard built before the
re-key. Serial in-Lambda filling can't cover a full-ladder rebuild
(~150 shards × 1-4 min ≫ the 12-min budget), and `e` costs hours of
16-core wall time plus a live box. Instead: discover gaps locally
(~seconds), then invoke the schedule-less `ctbk-avail-rebuild` function
once per gap — concurrency bounded only by the driver's thread pool.

Invocations are SYNCHRONOUS (`RequestResponse` from a thread pool)
rather than the async+poll sketch in the spec: the driver learns each
shard's exact status from the invoke response — no D1/R2 completion
polling, and no Lambda-service async retries that could double-invoke.

Layering: gaps are grouped by `(tier, rung)` in dependency order
(finest tier first, smallest rung first) with a barrier between
layers. Rung barriers matter within a tier: `materialize_extension_shard`
tiles a gap from same-tier SUB-rung shards, so rebuilding `/1m@5min`
first (from raw) lets `/1m@10min`+ concat just-rebuilt tiles instead of
re-reading the raw WAL per rung. A layer-order violation is safe but
wasteful — a missing source bounces `no_inputs` and a re-run picks it
up (discovery sees fresh mtimes; completed shards skip).
"""
from __future__ import annotations

import json
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from utz import err

from .lite import AVAIL_GENESIS

REBUILD_FUNC = 'ctbk-avail-rebuild'
TICK_FUNC = 'ctbk-avail-cascade'


def touch_tick_function(function_name: str = TICK_FUNC) -> datetime:
    """Recycle the steady-state tick function's execution environments
    by bumping a no-op env var (`DENORM_REV`). Warm containers cache the
    station-luc chains per process (`_luc_chains`); after a denorm
    re-key they'd keep writing tail shards with the OLD anchors — with
    fresh mtimes, invisible to any `stale_before`. Returns the update's
    completion time: the earliest instant from which all tick writes are
    known to use the new denorm (the correct effective `stale_before`)."""
    import boto3
    lam = boto3.client('lambda')
    cfg = lam.get_function_configuration(FunctionName=function_name)
    env = cfg['Environment']['Variables']
    env['DENORM_REV'] = datetime.now(timezone.utc).isoformat()
    lam.update_function_configuration(
        FunctionName=function_name, Environment={'Variables': env})
    lam.get_waiter('function_updated').wait(FunctionName=function_name)
    ts = datetime.now(timezone.utc)
    err(f"touched {function_name} (DENORM_REV={env['DENORM_REV']}) — "
        f"effective stale_before {ts.isoformat()}")
    return ts


def run_rebuild(
    config_yaml: str,
    *,
    stale_before: datetime | None = None,
    touch_tick: bool = False,
    concurrency: int = 16,
    function_name: str = REBUILD_FUNC,
    dry_run: bool = False,
    limit: int | None = None,
) -> dict[str, int]:
    """Discover → layer → fan out. Returns `{status: count}`.

    Idempotent + resumable: a re-run's discovery sees fresh mtimes and
    'exists'-skips completed shards; a killed driver loses nothing
    (per-shard D1 registration happens inside each invocation)."""
    from pyrmts import parse_pyramid_yaml, pyramid_from_config
    from .fsck import discover_gaps, group_by_tier_rung
    from .lambda_exec import encode_gap, merge_lambda_shards
    from .storage import storage_from_cfg

    if touch_tick:
        if dry_run:
            err('(dry-run: skipping tick touch; planning with stale_before=now)')
            ts = datetime.now(timezone.utc)
        else:
            ts = touch_tick_function()
        stale_before = ts if stale_before is None else max(stale_before, ts)

    now = datetime.now(timezone.utc)
    merged_yaml = merge_lambda_shards(config_yaml)
    cfg = parse_pyramid_yaml(merged_yaml)
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    gaps, _existing, _expected = discover_gaps(
        pyramid, (AVAIL_GENESIS, now), stale_before=stale_before)
    # Trailing max-shards whose notional period ends pre-genesis can
    # never exist (same exclusion as `run_extension_fill`).
    gaps = [g for g in gaps if g.period_end > AVAIL_GENESIS]
    layers = group_by_tier_rung(gaps)
    err(f"rebuild: {len(gaps)} shards across {len(layers)} (tier, rung) layers")
    if dry_run:
        for tier, rung, batch in layers:
            err(f"  /{tier}@{rung}: {len(batch)} "
                f"({batch[0].period_start.date()}..{batch[-1].period_start.date()})")
        return {}

    import boto3
    from botocore.config import Config
    lam = boto3.client('lambda', config=Config(
        connect_timeout=10,
        read_timeout=920,  # ≥ the function's 900 s timeout
        max_pool_connections=concurrency + 4,
        # No transport-level retries: a read timeout must not re-invoke
        # a shard build (idempotent, but doubles the work).
        retries={'mode': 'standard', 'max_attempts': 1},
    ))
    sb_iso = stale_before.isoformat() if stale_before else None

    def invoke(gap) -> dict:
        payload: dict = {'gap': encode_gap(gap)}
        if sb_iso:
            payload['stale_before'] = sb_iso
        resp = lam.invoke(FunctionName=function_name,
                          Payload=json.dumps(payload).encode())
        body = json.loads(resp['Payload'].read() or b'null')
        if resp.get('FunctionError'):
            return {'status': 'error', 'error': json.dumps(body)[:300]}
        return body or {'status': 'error', 'error': 'empty invoke response'}

    by_status: dict[str, int] = {}
    done = 0
    t0 = _time.time()
    for tier, rung, batch in layers:
        if limit is not None:
            if done >= limit:
                err(f"  hit --limit {limit}; stopping")
                break
            batch = batch[:limit - done]
        lt0 = _time.time()
        layer_status: dict[str, int] = {}
        with ThreadPoolExecutor(max_workers=min(concurrency, len(batch))) as pool:
            futs = {pool.submit(invoke, g): g for g in batch}
            for fut in as_completed(futs):
                g = futs[fut]
                try:
                    r = fut.result()
                except Exception as e:
                    r = {'status': 'error', 'error': str(e)}
                st = r.get('status') or 'error'
                layer_status[st] = layer_status.get(st, 0) + 1
                by_status[st] = by_status.get(st, 0) + 1
                done += 1
                if st in ('error', 'no_inputs'):
                    detail = f": {r['error']}" if r.get('error') else ""
                    err(f"  ! /{g.tier}@{g.shard_dur} {g.period_start.date()} → {st}{detail}")
        err(f"  /{tier}@{rung}: {len(batch)} → "
            + ", ".join(f"{k}={v}" for k, v in sorted(layer_status.items()))
            + f" ({_time.time() - lt0:.0f}s)")
    err(f"rebuild: {done} shards in {(_time.time() - t0) / 60:.1f} min: "
        + (", ".join(f"{k}={v}" for k, v in sorted(by_status.items())) or "nothing to do"))
    if by_status.get('no_inputs') or by_status.get('error'):
        err("some shards bounced — re-run the same command to retry "
            "(discovery skips completed shards)")
    return by_status
