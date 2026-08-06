#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3", "click"]
# ///
"""Build + deploy the cascade Lambdas as container images (successor to
`deploy.py`'s zip path — see pyrmts `specs/pyrmts-ops-adoption.md`, the
P2/P3 polars blocker).

Stages a minimal build context (handler + configs + trimmed `ctbk`
package + pyrmts wheels built from the local checkout), docker-builds
linux/arm64, pushes to ECR, and creates/updates the three functions as
Image-type. zip→image can't convert in place: existing Zip-type
functions are deleted and recreated (same names/ARNs; EventBridge rules
re-target + invoke permission re-added).

Usage:
    gbfs/lambda/deploy-image.py            # build + push + deploy all
    gbfs/lambda/deploy-image.py -n         # build image only
    gbfs/lambda/deploy-image.py -5         # deploy only the v5 tick
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import boto3
from click import command, option

err = lambda *a: print(*a, file=sys.stderr)

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
PYRMTS = Path.home() / 'c' / 'pyrmts' / 'python'
ECR_REPO = 'ctbk-avail-lambda'
REGION = 'us-east-1'

FUNC = 'ctbk-avail-cascade'
V5_FUNC = 'ctbk-avail-cascade-v5'
REBUILD_FUNC = 'ctbk-avail-rebuild'
ROLE = f'{FUNC}-role'
MEMORY_MB = 10240
REBUILD_MEMORY_MB = 5376
TIMEOUT_S = 900
ENV_KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
# Registry-proxy config (D1 via the api worker's binding — the CF D1
# REST split-brain workaround); included when present in the deploy env.
OPTIONAL_ENV = ['CTBK_REGISTRY_URL', 'CTBK_REGISTRY_SECRET']

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
CONFIGS = ['avail.yaml', 'avail-v4.yaml', 'avail-v5.yaml', 'avail-v6.yaml', 'station-vocab.json']


def stage_context() -> Path:
    ctx = HERE / 'build-ctx'
    if ctx.exists():
        shutil.rmtree(ctx)
    (ctx / 'configs').mkdir(parents=True)
    (ctx / 'wheels').mkdir()
    shutil.copy(HERE / 'handler.py', ctx / 'handler.py')
    shutil.copy(HERE / 'Dockerfile', ctx / 'Dockerfile')
    for c in CONFIGS:
        shutil.copy(REPO / 'configs' / 'pyramids' / c, ctx / 'configs' / c)
    (ctx / 'ctbk' / '__init__.py').parent.mkdir(parents=True)
    (ctx / 'ctbk' / '__init__.py').write_text('')
    for rel in CTBK_MODULES:
        dst = ctx / 'ctbk' / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / 'ctbk' / rel, dst)
    for pkg in ['pyrmts', 'pyrmts_engine', 'pyrmts_ops']:
        subprocess.run(['uv', 'build', '--wheel', str(PYRMTS / pkg), '-o', str(ctx / 'wheels')], check=True)
    return ctx


def image_uri(sts) -> str:
    acct = sts.get_caller_identity()['Account']
    return f'{acct}.dkr.ecr.{REGION}.amazonaws.com/{ECR_REPO}:latest'


def build_push(uri: str, *, push: bool = True) -> None:
    ctx = stage_context()
    # --provenance/--sbom=false: Lambda requires a single-platform Docker
    # manifest; buildx attestations produce an OCI index it rejects.
    subprocess.run(['docker', 'build', '--platform', 'linux/arm64', '--provenance=false', '--sbom=false', '-t', uri, str(ctx)], check=True)
    if not push:
        return
    ecr = boto3.client('ecr', region_name=REGION)
    try:
        ecr.describe_repositories(repositoryNames=[ECR_REPO])
    except ecr.exceptions.RepositoryNotFoundException:
        ecr.create_repository(repositoryName=ECR_REPO)
        err(f'created ECR repo {ECR_REPO}')
    login = subprocess.run(
        ['aws', 'ecr', 'get-login-password', '--region', REGION],
        check=True, capture_output=True, text=True).stdout
    subprocess.run(
        ['docker', 'login', '--username', 'AWS', '--password-stdin', uri.split('/')[0]],
        input=login, text=True, check=True, capture_output=True)
    subprocess.run(['docker', 'push', uri], check=True)


def recreate_function(
    lam,
    role_arn: str,
    uri: str,
    *,
    name: str,
    description: str,
    env_extra: dict[str, str],
    reserved: int | None,
    memory_mb: int,
) -> str:
    env = {'Variables': {k: os.environ[k] for k in ENV_KEYS}
           | {k: os.environ[k] for k in OPTIONAL_ENV if k in os.environ}
           | env_extra}
    try:
        existing = lam.get_function(FunctionName=name)['Configuration']
        if existing.get('PackageType') == 'Image':
            lam.update_function_code(FunctionName=name, ImageUri=uri)
            lam.get_waiter('function_updated').wait(FunctionName=name)
            lam.update_function_configuration(
                FunctionName=name, Role=role_arn, Timeout=TIMEOUT_S,
                MemorySize=memory_mb, Environment=env, Description=description)
            err(f'updated image function {name}')
        else:
            # zip→image can't convert in place. Preserve env we don't
            # rebuild (none today), delete, recreate.
            lam.delete_function(FunctionName=name)
            err(f'deleted zip function {name}; recreating as image')
            raise lam.exceptions.ResourceNotFoundException({}, '')
    except lam.exceptions.ResourceNotFoundException:
        last = None
        for attempt in range(12):
            try:
                lam.create_function(
                    FunctionName=name, PackageType='Image',
                    Code={'ImageUri': uri}, Role=role_arn,
                    Architectures=['arm64'], Timeout=TIMEOUT_S,
                    MemorySize=memory_mb, Environment=env,
                    Description=description)
                last = None
                break
            except lam.exceptions.InvalidParameterValueException as e:
                # Role/delete propagation is retryable; anything else
                # (e.g. an OCI-index manifest Lambda can't pull) is not —
                # either way, surface the message.
                last = e
                err(f'  create_function retry {attempt}: {e}')
                time.sleep(5)
        if last is not None:
            raise last
        err(f'created image function {name}')
    lam.get_waiter('function_active_v2').wait(FunctionName=name)
    if reserved is not None:
        lam.put_function_concurrency(FunctionName=name, ReservedConcurrentExecutions=reserved)
    else:
        try:
            lam.delete_function_concurrency(FunctionName=name)
        except lam.exceptions.ResourceNotFoundException:
            pass
    return lam.get_function(FunctionName=name)['Configuration']['FunctionArn']


def ensure_schedule(events, lam, func_arn: str, *, func_name: str, rule: str, rate: str, input_json: str | None, description: str) -> None:
    rule_arn = events.put_rule(Name=rule, ScheduleExpression=rate, State='ENABLED', Description=description)['RuleArn']
    target: dict = {'Id': 'fn', 'Arn': func_arn}
    if input_json is not None:
        target['Input'] = input_json
    events.put_targets(Rule=rule, Targets=[target])
    try:
        # Per-rule statement id: a constant id here silently no-ops for
        # every rule after the first (the conflict pass-through), leaving
        # later rules without invoke permission — EventBridge fires, the
        # Lambda rejects (bit the v6 tick, 2026-08-06).
        lam.add_permission(FunctionName=func_name, StatementId=f'invoke-{rule}',
                           Action='lambda:InvokeFunction', Principal='events.amazonaws.com',
                           SourceArn=rule_arn)
    except lam.exceptions.ResourceConflictException:
        pass
    err(f'schedule {rule}: {rate}' + (f' input={input_json}' if input_json else ''))


@command()
@option('-5', '--v5-only', is_flag=True, help='Deploy only the v5 tick function.')
@option('-n', '--build-only', is_flag=True, help='Stage + docker build only; no push/deploy.')
def main(v5_only: bool, build_only: bool):
    missing = [k for k in ENV_KEYS if k not in os.environ]
    if not build_only and missing:
        raise SystemExit(f'missing env: {missing} (source .envrc)')
    sess = boto3.Session(region_name=REGION)
    uri = image_uri(sess.client('sts'))
    build_push(uri, push=not build_only)
    if build_only:
        err(f'built {uri} (not pushed)')
        return
    lam = sess.client('lambda')
    events = sess.client('events')
    role_arn = sess.client('iam').get_role(RoleName=ROLE)['Role']['Arn']

    v5_arn = recreate_function(
        lam, role_arn, uri, name=V5_FUNC,
        description='avail-v5 cascade tick (image; specs/avail-v5-stack.md)',
        env_extra={'GC_ENABLED': os.environ.get('GC_ENABLED', '0'), 'FILL_ALL': '1'},
        reserved=1, memory_mb=MEMORY_MB)
    ensure_schedule(events, lam, v5_arn, func_name=V5_FUNC, rule=f'{V5_FUNC}-tick',
                    rate='cron(3/5 * * * ? *)', input_json='{"config": "avail-v5"}',
                    description='avail-v5 cascade fill')
    # v6 tick rides the same (config-driven) function; the offset minute +
    # reserved=1 serialize it behind the v5 tick. Both run until cutover
    # (default flip + v5 GC), then the v5 rule is deleted.
    ensure_schedule(events, lam, v5_arn, func_name=V5_FUNC, rule='ctbk-avail-cascade-v6-tick',
                    rate='cron(4/5 * * * ? *)', input_json='{"config": "avail-v6"}',
                    description='avail-v6 cascade fill (LU-attributed successor)')
    err(f'deployed: {v5_arn}')
    if v5_only:
        return

    func_arn = recreate_function(
        lam, role_arn, uri, name=FUNC,
        description='avail-v3 cascade tick (image)',
        env_extra={'GC_ENABLED': os.environ.get('GC_ENABLED', '0'), 'FILL_ALL': '1'},
        reserved=1, memory_mb=MEMORY_MB)
    ensure_schedule(events, lam, func_arn, func_name=FUNC, rule=f'{FUNC}-hourly',
                    rate='cron(1/5 * * * ? *)', input_json=None,
                    description='avail-v3 cascade fill')
    rebuild_arn = recreate_function(
        lam, role_arn, uri, name=REBUILD_FUNC,
        description='single-gap rebuild fan-out (image; no schedule)',
        env_extra={'GC_ENABLED': '0', 'FILL_ALL': '1'},
        reserved=None, memory_mb=REBUILD_MEMORY_MB)
    err(f'deployed: {func_arn}')
    err(f'deployed: {rebuild_arn}')


if __name__ == '__main__':
    main()
