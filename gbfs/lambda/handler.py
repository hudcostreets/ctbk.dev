"""AWS Lambda handler: avail-v3 heavy-rung cascade (P1).

Hourly EventBridge → discover + fill missing pyramid shards that have a
same-tier sub-cover (ladder-extension rungs, plus any in-ladder rung the
CFW bounced), registering each in D1 via the CF REST API. See
`specs/avail-v3-lambda-cascade.md`.

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
    results = run_extension_fill(
        config_yaml,
        register=True,
        time_budget_s=TIME_BUDGET_S,
    )
    by_status: dict[str, int] = {}
    for r in results:
        by_status[r.status] = by_status.get(r.status, 0) + 1

    gc = None
    if os.environ.get('GC_ENABLED') == '1':
        from ctbk.pyramid_cascade.gc import gc_sweep
        r = gc_sweep(config_yaml)
        gc = {'eligible': r.eligible, 'deleted': r.deleted, 'skipped': r.skipped}

    return {'filled': by_status, 'total': len(results), 'gc': gc}
