"""AWS Lambda handler: avail pyramid cascade ticks + fan-out rebuilds.

Thin shim over `pyrmts_ops.lambda_entry` (ops-adoption phase 3): the
dispatch — config validation, single-gap vs discovery branch, time
budget, GC cadence, response shapes — lives upstream; ctbk provides the
`load` seam (`build_lambda_app`: merged-ladder pyramid, raw-WAL hole
fill, proxy-aware registry, cell-first sort).

Deployed as a container image (`gbfs/lambda/deploy-image.py`): this file
+ a trimmed `ctbk` package + pyrmts wheels; pyramid configs ship
alongside as `<config>.yaml`. The EventBridge tick sends
`{'config': '<name>'}` (default `avail`); fan-out events add `gap`.

Env: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID /
CLOUDFLARE_API_TOKEN [/ CTBK_REGISTRY_URL + CTBK_REGISTRY_SECRET —
worker-binding registration proxy / FILL_ALL / GC_ENABLED].
"""
import os
from pathlib import Path

from pyrmts_ops import lambda_entry


def _load(config_name: str, event: dict):
    from ctbk.pyramid_cascade.lambda_exec import build_lambda_app
    config_yaml = (Path(__file__).parent / f'{config_name}.yaml').read_text()
    return build_lambda_app(config_yaml, config_name, event)


def lambda_handler(event, context):
    return lambda_entry(
        event,
        load=_load,
        default_config='avail',
        gc_enabled=os.environ.get('GC_ENABLED') == '1',
    )
