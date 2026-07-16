"""AWS Lambda handler: avail-v3 heavy-rung cascade (P1).

Hourly EventBridge → discover + fill missing pyramid shards that have a
same-tier sub-cover (ladder-extension rungs, plus any in-ladder rung the
CFW bounced), registering each in D1 via the CF REST API. See
`specs/avail-v3-lambda-cascade.md`.

Events with a `gap` key take the single-gap branch instead: materialize
exactly that shard (bulk-rebuild fan-out from `ctbk gbfs lambda
rebuild`, deployed as the schedule-less `ctbk-avail-rebuild` function —
`specs/avail-v3-lambda-rebuild.md`).

Bundle: this file + a trimmed `ctbk` package (`pyramid_cascade` only,
empty root `__init__`) + pyrmts + utz + pyyaml; pandas/pyarrow/numpy
come from the AWS-managed `AWSSDKPandas` layer; boto3 from the runtime.
`configs/pyramids/avail.yaml` ships alongside as `avail.yaml`.

Env: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID /
CLOUDFLARE_API_TOKEN [/ GC_ENABLED — reserved; GC lands after the api
worker's health config adopts the extended ladder, per spec].
"""
import os
from pathlib import Path

# ~3 min headroom under the 15-min Lambda timeout: finish the in-flight
# shard + its D1 registration, plus a safety margin.
TIME_BUDGET_S = 12 * 60


def lambda_handler(event, context):
    from ctbk.pyramid_cascade.lambda_exec import run_extension_fill

    config_yaml = (Path(__file__).parent / 'avail.yaml').read_text()

    if 'gap' in event:
        # Single-gap invocation from the fan-out rebuild driver
        # (`ctbk gbfs lambda rebuild` — specs/avail-v3-lambda-rebuild.md):
        # materialize + register exactly one shard, skip discovery/GC.
        from datetime import datetime
        from ctbk.pyramid_cascade.lambda_exec import decode_gap, run_single_gap
        sb = event.get('stale_before')
        res = run_single_gap(
            config_yaml,
            decode_gap(event['gap']),
            stale_before=datetime.fromisoformat(sb) if sb else None,
            # register=False marks a driver-planned SCAFFOLD shard:
            # unregistered so D1-gated reads and the D1-driven GC never
            # see it; the driver deletes it after the parent layer.
            register=event.get('register', True),
        )
        return {
            'status': res.status,
            'key': res.gap.key,
            'rows': res.rows,
            'bytes': res.bytes_written,
            'source': res.source_desc,
            'error': res.error,
        }

    results = run_extension_fill(
        config_yaml,
        register=True,
        time_budget_s=TIME_BUDGET_S,
        # P2 cutover flag: also own each tier's smallest rung (raw
        # ingest / cross-tier). Off while the CFW cascade runs them.
        fill_all=os.environ.get('FILL_ALL') == '1',
    )
    by_status: dict[str, int] = {}
    for r in results:
        by_status[r.status] = by_status.get(r.status, 0) + 1

    gc = None
    from datetime import datetime, timezone
    # At the 5-min cadence (FILL_ALL cutover, firings at :01/:06/…),
    # sweep on the hour's first firing only — a full GC scan per tick
    # buys nothing. The pre-cutover hourly cadence always sweeps.
    frequent = os.environ.get('FILL_ALL') == '1'
    if os.environ.get('GC_ENABLED') == '1' and (not frequent or datetime.now(timezone.utc).minute < 5):
        from ctbk.pyramid_cascade.gc import gc_sweep
        r = gc_sweep(config_yaml)
        gc = {'eligible': r.eligible, 'deleted': r.deleted, 'skipped': r.skipped}

    return {'filled': by_status, 'total': len(results), 'gc': gc}
