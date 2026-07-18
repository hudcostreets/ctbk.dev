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

# Max whole-period fill size per invocation, in SOURCE bins (raw minutes
# for the finest tier; source-tier bins elsewhere). A rebuilt-from-scratch
# max-rung shard has no fresh sub-rungs to concat (GC swept them long
# ago), so its build degenerates to a full-period raw/cross-tier fill —
# measured in-Lambda: /1m@12h (720 raw minutes) = 258 s; /1m@2d (2880)
# times out at the hard 900 s cap. 720 leaves ~3.5× headroom.
SOURCE_BIN_BUDGET = 720


def fill_safe_rung(pyramid, tier) -> str:
    """Largest rung of `tier` whose whole-period fill fits
    `SOURCE_BIN_BUDGET` — the scaffold rung for bigger siblings."""
    from .lambda_exec import _source_tier_for
    from .lite import dur_min
    src = _source_tier_for(pyramid, tier.name)
    src_bin = dur_min(src.bin) if src is not None else 1  # finest tier fills from raw minutes
    fits = [r for r in tier.shards if dur_min(r) // src_bin <= SOURCE_BIN_BUDGET]
    if not fits:
        raise ValueError(f"tier {tier.name}: no rung fits {SOURCE_BIN_BUDGET} source bins")
    return max(fits, key=dur_min)


def expand_scaffolds(
    pyramid,
    layers: list[tuple[str, str, list]],
) -> list[tuple[str, str, list, bool]]:
    """Insert scaffold layers so no invocation's fill exceeds the budget.

    For each tier, rungs above its fill-safe rung F get a preceding
    layer of F-sized shards tiling their gap periods (epoch-aligned; gap
    periods are F-aligned by the divisibility chain). The big rungs then
    concat 2-16 fresh F-tiles instead of raw/cross-tier-filling their
    whole period. Scaffolds are deduped across the tier's big rungs.

    Scaffolds are real in-ladder shards but are invoked with
    `register=False`: `gc_sweep` is D1-driven, so unregistered keys
    can't be GC'd mid-rebuild (the hourly sweep would otherwise see a
    same-tier covering parent — the STALE max-rung shard — and delete a
    scaffold before its parent concat runs); D1-gated reads never see
    them either. The driver deletes them after a clean run; a bounced
    run keeps them, and the re-run reuses them (fresh mtimes → picked
    up by the in-Lambda listing, 'exists'-skipped as scaffold targets).

    Returns `(tier, rung, batch, is_scaffold)` layers in fill order.
    """
    from datetime import timedelta
    from pyrmts import ExpectedShard
    from .lambda_exec import _shard_key
    from .lite import dur_min

    tiers = {t.name: t for t in pyramid.tiers}
    out: list[tuple[str, str, list, bool]] = []
    scaffolded: dict[str, set[str]] = {}  # tier -> scaffold keys already planned
    for tier_name, rung, batch in layers:
        tier = tiers[tier_name]
        safe = fill_safe_rung(pyramid, tier)
        if dur_min(rung) > dur_min(safe):
            dur = timedelta(minutes=dur_min(safe))
            seen = scaffolded.setdefault(tier_name, set())
            slots: list[ExpectedShard] = []
            for gap in batch:
                cur = gap.period_start
                while cur < gap.period_end:
                    slot_end = cur + dur
                    key = _shard_key(pyramid, tier_name, safe, cur)
                    if slot_end > AVAIL_GENESIS and key not in seen:
                        seen.add(key)
                        slots.append(ExpectedShard(
                            tier=tier_name, shard_dur=safe,
                            period_start=cur, period_end=slot_end, key=key,
                        ))
                    cur = slot_end
            if slots:
                out.append((tier_name, safe, slots, True))
        out.append((tier_name, rung, batch, False))
    return out


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
    keep_scaffolds: bool = False,
    config_name: str = 'avail',
) -> dict[str, int]:
    """Discover → layer (+ scaffolds) → fan out. Returns `{status: count}`.

    Idempotent + resumable: a re-run's discovery sees fresh mtimes and
    'exists'-skips completed shards; a killed driver loses nothing
    (per-shard D1 registration happens inside each invocation), and
    leftover scaffolds get reused then cleaned by the re-run."""
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
    gaps, _existing, expected_by_tier = discover_gaps(
        pyramid, (AVAIL_GENESIS, now), stale_before=stale_before)
    # Trailing max-shards whose notional period ends pre-genesis can
    # never exist (same exclusion as `run_extension_fill`).
    gaps = [g for g in gaps if g.period_end > AVAIL_GENESIS]
    layers = expand_scaffolds(pyramid, group_by_tier_rung(gaps))
    n_scaffold = sum(len(b) for _, _, b, s in layers if s)
    err(f"rebuild: {len(gaps)} shards + {n_scaffold} scaffolds across "
        f"{len(layers)} (tier, rung) layers")
    if dry_run:
        for tier, rung, batch, is_scaffold in layers:
            err(f"  /{tier}@{rung}{' [scaffold]' if is_scaffold else ''}: {len(batch)} "
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

    def invoke(gap, register: bool) -> dict:
        payload: dict = {'gap': encode_gap(gap), 'register': register, 'config': config_name}
        if sb_iso:
            payload['stale_before'] = sb_iso
        resp = lam.invoke(FunctionName=function_name,
                          Payload=json.dumps(payload).encode())
        body = json.loads(resp['Payload'].read() or b'null')
        if resp.get('FunctionError'):
            return {'status': 'error', 'error': json.dumps(body)[:300]}
        return body or {'status': 'error', 'error': 'empty invoke response'}

    by_status: dict[str, int] = {}
    scaffold_keys: set[str] = set()
    done = 0
    t0 = _time.time()
    for tier, rung, batch, is_scaffold in layers:
        if limit is not None:
            if done >= limit:
                err(f"  hit --limit {limit}; stopping")
                break
            batch = batch[:limit - done]
        if is_scaffold:
            scaffold_keys.update(g.key for g in batch)
        lt0 = _time.time()
        layer_status: dict[str, int] = {}
        with ThreadPoolExecutor(max_workers=min(concurrency, len(batch))) as pool:
            futs = {pool.submit(invoke, g, not is_scaffold): g for g in batch}
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
        err(f"  /{tier}@{rung}{' [scaffold]' if is_scaffold else ''}: {len(batch)} → "
            + ", ".join(f"{k}={v}" for k, v in sorted(layer_status.items()))
            + f" ({_time.time() - lt0:.0f}s)")
    err(f"rebuild: {done} shards in {(_time.time() - t0) / 60:.1f} min: "
        + (", ".join(f"{k}={v}" for k, v in sorted(by_status.items())) or "nothing to do"))

    bounced = (bool(by_status.get('no_inputs') or by_status.get('error'))
               or (limit is not None and done >= limit))
    if bounced:
        err("some shards bounced — re-run the same command to retry "
            "(discovery skips completed shards; scaffolds kept for reuse)")
    # Expected-cover keys are never scaffolds to clean: a scaffold slot
    # coinciding with an expected shard was rebuilt (and registered) in
    # its own earlier layer and must stay.
    expected_keys = {e.key for batch in expected_by_tier.values() for e in batch}
    to_clean = sorted(scaffold_keys - expected_keys)
    if to_clean and not bounced and not keep_scaffolds:
        from .lite import R2_BUCKET, r2_client
        r2 = r2_client()
        for key in to_clean:
            r2.delete_object(Bucket=R2_BUCKET, Key=key)
        err(f"cleaned {len(to_clean)} scaffold keys")
    elif to_clean:
        err(f"kept {len(to_clean)} scaffold keys (unregistered; reused by a re-run)")
    return by_status
