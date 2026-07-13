#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3", "click"]
# ///
"""Build + deploy the avail-v3 cascade Lambda (`ctbk-avail-cascade`).

Plain boto3 (no CDK): builds the zip from the local venv's
pure-python deps + a trimmed `ctbk` package, then upserts the IAM
role, function, and hourly EventBridge rule. Idempotent — re-run to
redeploy code or config.

Usage (AWS_PROFILE=r via .envrc):
    gbfs/lambda/deploy.py            # build + deploy
    gbfs/lambda/deploy.py -n         # build zip only, report size
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import boto3
from click import command, option

err = lambda *a: print(*a, file=sys.stderr)

FUNC = 'ctbk-avail-cascade'
ROLE = f'{FUNC}-role'
RULE = f'{FUNC}-hourly'
# pandas + pyarrow + numpy. Region-specific ARN (us-east-1); versions:
# https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html
PANDAS_LAYER = 'arn:aws:lambda:us-east-1:336392948345:layer:AWSSDKPandas-Python312:18'
MEMORY_MB = 10240
TIMEOUT_S = 900

REPO = Path(__file__).resolve().parents[2]

# Trimmed `ctbk` package: the Lambda import path only (polars/click/
# pandas-free by construction — see `pyramid_cascade/lite.py`).
CTBK_MODULES = [
    'pyramid_cascade/__init__.py',
    'pyramid_cascade/lite.py',
    'pyramid_cascade/config.py',
    'pyramid_cascade/fsck.py',
    'pyramid_cascade/storage.py',
    'pyramid_cascade/d1_http.py',
    'pyramid_cascade/lambda_exec.py',
    'pyramid_cascade/gc.py',
]
# Pure-python site-packages to vendor (pandas/pyarrow via layer; boto3
# via runtime). C-extension .so files are excluded — pyyaml falls back
# to its pure-python loader without `_yaml`.
VENDOR = ['pyrmts', 'utz', 'yaml']

ENV_KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']


def site_packages() -> Path:
    """The repo venv's site-packages (this script runs in its own
    uv-managed env, so vendored deps come from the project venv —
    versions as pinned by `uv.lock`)."""
    hits = sorted((REPO / '.venv').glob('*/lib/python3.*/site-packages'))
    if not hits:
        hits = sorted((REPO / '.venv').glob('lib/python3.*/site-packages'))
    if not hits:
        raise SystemExit(f'no site-packages under {REPO}/.venv — run `uv sync`')
    return hits[-1]


def build_zip() -> bytes:
    buf = io.BytesIO()
    here = Path(__file__).parent
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(here / 'handler.py', 'handler.py')
        z.write(REPO / 'configs/pyramids/avail.yaml', 'avail.yaml')
        z.writestr('ctbk/__init__.py', '')  # NOT the repo's (heavy trips-ETL imports)
        for rel in CTBK_MODULES:
            z.write(REPO / 'ctbk' / rel, f'ctbk/{rel}')
        sp = site_packages()
        for pkg in VENDOR:
            root = sp / pkg
            if not root.is_dir():
                raise SystemExit(f'{pkg} not found in {sp}')
            for f in sorted(root.rglob('*')):
                if f.is_dir() or '__pycache__' in f.parts or f.suffix == '.so':
                    continue
                z.write(f, str(f.relative_to(sp)))
    return buf.getvalue()


def upsert_role(iam) -> str:
    trust = json.dumps({
        'Version': '2012-10-17',
        'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}],
    })
    try:
        arn = iam.get_role(RoleName=ROLE)['Role']['Arn']
    except iam.exceptions.NoSuchEntityException:
        arn = iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=trust,
                              Description='avail-v3 cascade Lambda (R2/D1 are external; logs only)')['Role']['Arn']
        iam.attach_role_policy(RoleName=ROLE,
                               PolicyArn='arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
        err(f'created role {ROLE}; waiting for propagation')
        time.sleep(10)
    return arn


def upsert_function(lam, role_arn: str, blob: bytes) -> str:
    env = {'Variables': {k: os.environ[k] for k in ENV_KEYS} | {'GC_ENABLED': '1'}}
    cfg = dict(
        Runtime='python3.12', Role=role_arn, Handler='handler.lambda_handler',
        Timeout=TIMEOUT_S, MemorySize=MEMORY_MB, Layers=[PANDAS_LAYER], Environment=env,
        Description='avail-v3 heavy-rung cascade (specs/avail-v3-lambda-cascade.md P1)',
    )
    try:
        lam.get_function(FunctionName=FUNC)
        lam.update_function_code(FunctionName=FUNC, ZipFile=blob)
        lam.get_waiter('function_updated').wait(FunctionName=FUNC)
        lam.update_function_configuration(FunctionName=FUNC, **cfg)
        err(f'updated {FUNC}')
    except lam.exceptions.ResourceNotFoundException:
        lam.create_function(FunctionName=FUNC, Code={'ZipFile': blob}, **cfg)
        err(f'created {FUNC}')
    lam.get_waiter('function_updated').wait(FunctionName=FUNC)
    lam.put_function_concurrency(FunctionName=FUNC, ReservedConcurrentExecutions=1)
    return lam.get_function(FunctionName=FUNC)['Configuration']['FunctionArn']


def upsert_schedule(events, lam, func_arn: str) -> None:
    rule_arn = events.put_rule(Name=RULE, ScheduleExpression='rate(1 hour)', State='ENABLED',
                               Description='hourly avail-v3 heavy-rung fill')['RuleArn']
    events.put_targets(Rule=RULE, Targets=[{'Id': 'fn', 'Arn': func_arn}])
    try:
        lam.add_permission(FunctionName=FUNC, StatementId='events-invoke',
                           Action='lambda:InvokeFunction', Principal='events.amazonaws.com',
                           SourceArn=rule_arn)
    except lam.exceptions.ResourceConflictException:
        pass
    err(f'schedule {RULE}: rate(1 hour)')


@command()
@option('-n', '--dry-run', is_flag=True, help='Build the zip and report its size; no AWS calls.')
def main(dry_run: bool):
    missing = [k for k in ENV_KEYS if k not in os.environ]
    if not dry_run and missing:
        raise SystemExit(f'missing env: {missing} (source .envrc)')
    blob = build_zip()
    err(f'zip: {len(blob)/1e6:.1f} MB')
    if dry_run:
        return
    sess = boto3.Session()
    role_arn = upsert_role(sess.client('iam'))
    lam = sess.client('lambda')
    func_arn = upsert_function(lam, role_arn, blob)
    upsert_schedule(sess.client('events'), lam, func_arn)
    err(f'deployed: {func_arn}')


if __name__ == '__main__':
    main()
