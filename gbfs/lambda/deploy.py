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
# v5 tick: same zip/handler, EventBridge Input pins `config=avail-v5` —
# the engine-backfilled successor pyramid (`specs/avail-v5-stack.md`).
# Separate function so its reserved=1 tick can't contend with v3's, and
# burn-in failures stay isolated.
V5_FUNC = 'ctbk-avail-cascade-v5'
V5_RULE = f'{V5_FUNC}-tick'
# Same zip, no schedule, UNRESERVED concurrency: invoked per-gap by the
# `ctbk gbfs lambda rebuild` fan-out driver (whose `-c` is the bound) —
# see `specs/avail-v3-lambda-rebuild.md`. Separate function because
# reserved concurrency is function-level in AWS (aliases can't have
# their own), and the minutely tick must keep `reserved=1` semantics.
REBUILD_FUNC = 'ctbk-avail-rebuild'
ROLE = f'{FUNC}-role'
RULE = f'{FUNC}-hourly'
# pandas + pyarrow + numpy. Region-specific ARN (us-east-1); versions:
# https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html
PANDAS_LAYER = 'arn:aws:lambda:us-east-1:336392948345:layer:AWSSDKPandas-Python312:18'
MEMORY_MB = 10240      # tick fn: accumulator path peaks ~6 GB at N=4096
# Rebuild fn: fan-out materializers measured p95 3.95 / max 4.31 GB over
# a full from-scratch build — 10 GB was ~2.3× oversized at the median
# (Lambda bills memory×time; this is ~46% of the fan-out's cost).
REBUILD_MEMORY_MB = 5376
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
    'pyramid_cascade/vocab.py',
    'pyramid_cascade/gc.py',
]
# Pure-python site-packages to vendor (pandas/pyarrow via layer; boto3
# via runtime). C-extension .so files are excluded — pyyaml falls back
# to its pure-python loader without `_yaml`.
VENDOR = ['pyrmts', 'utz', 'yaml', 's2cell']

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
        z.write(REPO / 'configs/pyramids/avail-v4.yaml', 'avail-v4.yaml')
        z.write(REPO / 'configs/pyramids/avail-v5.yaml', 'avail-v5.yaml')
        z.write(REPO / 'configs/pyramids/station-vocab.json', 'station-vocab.json')
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


def upsert_function(
    lam,
    role_arn: str,
    blob: bytes,
    *,
    name: str,
    description: str,
    env_extra: dict[str, str],
    reserved: int | None,
    memory_mb: int = MEMORY_MB,
) -> str:
    env = {'Variables': {k: os.environ[k] for k in ENV_KEYS} | env_extra}
    cfg = dict(
        Runtime='python3.12', Role=role_arn, Handler='handler.lambda_handler',
        Timeout=TIMEOUT_S, MemorySize=memory_mb, Layers=[PANDAS_LAYER], Environment=env,
        Description=description,
    )
    try:
        lam.get_function(FunctionName=name)
        lam.update_function_code(FunctionName=name, ZipFile=blob)
        lam.get_waiter('function_updated').wait(FunctionName=name)
        lam.update_function_configuration(FunctionName=name, **cfg)
        err(f'updated {name}')
    except lam.exceptions.ResourceNotFoundException:
        lam.create_function(FunctionName=name, Code={'ZipFile': blob}, **cfg)
        err(f'created {name}')
    lam.get_waiter('function_updated').wait(FunctionName=name)
    if reserved is not None:
        lam.put_function_concurrency(FunctionName=name, ReservedConcurrentExecutions=reserved)
    else:
        lam.delete_function_concurrency(FunctionName=name)
    return lam.get_function(FunctionName=name)['Configuration']['FunctionArn']


def upsert_schedule(
    events,
    lam,
    func_arn: str,
    *,
    func_name: str = FUNC,
    rule: str = RULE,
    rate: str | None = None,
    input_json: str | None = None,
    description: str = 'avail-v3 cascade fill',
) -> None:
    # FILL_ALL (P2 steady state, the default): fire at :01/:06/:11/… —
    # the smallest shard anywhere in the ladder spans 5 min, so that's
    # the work cadence; the +1-min phase lets the poller land each
    # boundary's final raw minute first (else the fill sees a recent
    # hole and defers a full cycle). FILL_ALL=0 (extensions-only +
    # hourly) is the rollback to the era when the CFW still ran the
    # sub-day cascade.
    if rate is None:
        rate = 'cron(1/5 * * * ? *)' if os.environ.get('FILL_ALL', '1') == '1' else 'rate(1 hour)'
    rule_arn = events.put_rule(Name=rule, ScheduleExpression=rate, State='ENABLED',
                               Description=description)['RuleArn']
    target = {'Id': 'fn', 'Arn': func_arn}
    if input_json is not None:
        target['Input'] = input_json
    events.put_targets(Rule=rule, Targets=[target])
    try:
        lam.add_permission(FunctionName=func_name, StatementId='events-invoke',
                           Action='lambda:InvokeFunction', Principal='events.amazonaws.com',
                           SourceArn=rule_arn)
    except lam.exceptions.ResourceConflictException:
        pass
    err(f'schedule {rule}: {rate}' + (f' input={input_json}' if input_json else ''))


@command()
@option('-5', '--v5-only', is_flag=True, help='Deploy only the v5 tick function + schedule; leave the serving v3 functions untouched.')
@option('-n', '--dry-run', is_flag=True, help='Build the zip and report its size; no AWS calls.')
def main(v5_only: bool, dry_run: bool):
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
    if not v5_only:
        func_arn = upsert_function(
            lam, role_arn, blob,
            name=FUNC,
            description='avail-v3 heavy-rung cascade (specs/avail-v3-lambda-cascade.md P1)',
            env_extra={'GC_ENABLED': '1', 'FILL_ALL': os.environ.get('FILL_ALL', '1')},
            reserved=1,
        )
        upsert_schedule(sess.client('events'), lam, func_arn)
    v5_arn = upsert_function(
        lam, role_arn, blob,
        name=V5_FUNC,
        description='avail-v5 cascade tick (engine-backfilled successor; specs/avail-v5-stack.md)',
        env_extra={'GC_ENABLED': '1', 'FILL_ALL': '1'},
        reserved=1,
    )
    # +3-min phase: offset from the v3 tick's :01/:06/… so the two
    # reserved=1 functions' R2/D1 traffic interleaves rather than spikes.
    upsert_schedule(
        sess.client('events'), lam, v5_arn,
        func_name=V5_FUNC, rule=V5_RULE, rate='cron(3/5 * * * ? *)',
        input_json='{"config": "avail-v5"}',
        description='avail-v5 cascade fill',
    )
    err(f'deployed: {v5_arn}')
    if v5_only:
        return
    # GC_ENABLED=0: only the scheduled tick should sweep — a stray {}
    # invocation of the rebuild function must not race a second GC.
    rebuild_arn = upsert_function(
        lam, role_arn, blob,
        name=REBUILD_FUNC,
        description='avail-v3 single-gap rebuild fan-out (specs/avail-v3-lambda-rebuild.md); no schedule',
        env_extra={'GC_ENABLED': '0', 'FILL_ALL': '1'},
        reserved=None,
        memory_mb=REBUILD_MEMORY_MB,
    )
    err(f'deployed: {func_arn}')
    err(f'deployed: {rebuild_arn}')


if __name__ == '__main__':
    main()
