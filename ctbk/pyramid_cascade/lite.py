"""Dependency-light pieces shared by the Lambda executor and the heavy
laptop/`e` paths (`materialize.py`, `avail_v3.py`).

The AWS Lambda bundle (see `gbfs/lambda/`) ships a trimmed `ctbk`
package — `pyramid_cascade` + an empty `__init__` — with pyarrow in the
zip and no pandas/polars/click. Anything the Lambda import path touches
must therefore avoid those; this module is the polars/click-free home
for the definitions `lambda_exec` needs from `materialize` and
`avail_v3` (which both re-import from here — single source of truth).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import boto3
from pyrmts import ExpectedShard
from pyrmts.axis import parse_duration

R2_BUCKET = 'ctbk'

# Earliest UTC timestamp for which raw /1m WAL data exists. Trailing
# max-shards emitted by `list_expected_shards` may cover pre-genesis
# periods; materializers clip source ranges to this and short-circuit
# shards whose entire period lies before it.
AVAIL_GENESIS = datetime(2026, 4, 7, 1, 15, tzinfo=timezone.utc)

UNIT_MIN = {'min': 1, 'h': 60, 'd': 1440, 'mo': 1440 * 30, 'y': 1440 * 365}


def dur_min(d: str) -> int:
    """Pyrmts Duration string → minutes."""
    p = parse_duration(d)
    return p.count * UNIT_MIN[p.unit]


def r2_endpoint() -> str:
    acct = os.environ['CLOUDFLARE_ACCOUNT_ID']
    return f'https://{acct}.r2.cloudflarestorage.com'


def r2_client():
    """Boto3 S3 client wired for R2.

    Prefers `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`; falls back to
    AWS profile `cf` (used locally with the R2 endpoint configured in
    `~/.aws/config`)."""
    if 'R2_ACCESS_KEY_ID' in os.environ and 'R2_SECRET_ACCESS_KEY' in os.environ:
        sess = boto3.Session(
            aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
            aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
            region_name='auto',
        )
    else:
        sess = boto3.Session(profile_name='cf', region_name='auto')
    return sess.client('s3', endpoint_url=r2_endpoint())


@dataclass
class MaterializeResult:
    gap: ExpectedShard
    status: str   # 'wrote' / 'exists' / 'no_inputs' / 'empty' / 'error'
    bytes_written: int = 0
    rows: int = 0
    inputs_present: int = 0
    inputs_expected: int = 0
    source_desc: str = ''  # e.g. '/1h@30d×2', '/1m@1d×60', 'raw'
    error: str | None = None
