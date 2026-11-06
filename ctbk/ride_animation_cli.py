"""One-month animation builds, staged locally before candidate publication."""
from datetime import datetime, timezone
from hashlib import md5
from json import dumps, loads
from os import environ
from pathlib import Path
from shlex import quote

from botocore.exceptions import ClientError
from click import Path as ClickPath, UsageError, option
from utz import err

from .cli.base import ctbk
from .gbfs_cli import _r2_client
from .ride_animation import build_month, station_bytes


@ctbk.group('rides-anim')
def rides_anim() -> None:
    """Build deterministic individual-ride animation files."""


@rides_anim.command('create')
@option('-d', '--date', 'ym', required=True, help='One source-start month, YYYYMM.')
@option('-i', '--input-dir', type=ClickPath(path_type=Path), default=None, help='Prefer local consolidated files; missing files use projected R2 reads.')
@option('-k', '--prefix', default='rides-anim-candidate/v1', show_default=True)
@option('-o', '--output', type=ClickPath(path_type=Path), default=Path('tmp/rides-anim-v1'), show_default=True)
@option('-u', '--upload', is_flag=True, help='Publish validated content-addressed files and merge the candidate index.')
def create(
    ym: str,
    input_dir: Path | None,
    prefix: str,
    output: Path,
    upload: bool,
) -> dict:
    import polars as pl
    from pyarrow.fs import S3FileSystem
    from pyarrow.parquet import read_table, write_table
    from .pyramid_cascade.rides_assets import _geo, _registry, effective_canonical
    from .pyramid_cascade.rides_source import station_positions
    if len(ym) != 6 or not ym.isdigit():
        raise UsageError('date must be YYYYMM')
    m0 = datetime.strptime(ym, '%Y%m').replace(tzinfo=timezone.utc)
    m1 = datetime(m0.year + 1, 1, 1, tzinfo=timezone.utc) if m0.month == 12 else m0.replace(month=m0.month + 1)
    if not prefix or prefix.startswith('/') or '..' in Path(prefix).parts:
        raise UsageError('prefix must be a relative bucket path')
    prefix = prefix.rstrip('/')
    r2, bucket = _r2_client(rw=upload)
    kp = 'R2_RW_' if (upload and environ.get('R2_RW_ACCESS_KEY_ID')) or not environ.get('R2_ACCESS_KEY_ID') else 'R2_'
    fs = S3FileSystem(
        access_key=environ[f'{kp}ACCESS_KEY_ID'], secret_key=environ[f'{kp}SECRET_ACCESS_KEY'],
        endpoint_override=r2.meta.endpoint_url, region='auto',
    )
    columns = ['Start Time', 'Stop Time', 'Start Station ID', 'End Station ID', 'Rideable Type', 'User Type']
    cache = Path('tmp/animation-inputs')
    cache.mkdir(parents=True, exist_ok=True)
    inputs = []
    frames = []
    for month in [m0, m1]:
        name = month.strftime('%Y%m')
        local = input_dir / f'{name}.parquet' if input_dir else None
        if local and local.exists():
            table = read_table(local, columns=columns)
            inputs.append({'month': name, 'local': str(local.resolve()), 'bytes': local.stat().st_size})
        else:
            key = f'normalized/{name}.parquet'
            try:
                head = r2.head_object(Bucket=bucket, Key=key)
            except ClientError as e:
                if month == m1 and e.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                    err(f'{name}: not published; animation month remains provisional')
                    continue
                raise
            etag = head['ETag']
            projected = cache / f'{name}.parquet'
            stamp = cache / f'{name}.json'
            if projected.exists() and stamp.exists() and loads(stamp.read_text())['etag'] == etag:
                table = read_table(projected)
            else:
                err(f'{name}: projected R2 read')
                table = read_table(f'{bucket}/{key}', filesystem=fs, columns=columns)
                write_table(table, projected, compression='snappy')
                stamp.write_text(dumps({'etag': etag}) + '\n')
            inputs.append({'month': name, 'key': key, 'etag': etag, 'bytes': head['ContentLength']})
        frames.append(pl.from_arrow(table))
    canonical = effective_canonical()
    positions = station_positions(_registry(), canonical, _geo())
    report = build_month(pl.concat(frames), int(m0.timestamp()), int(m1.timestamp()), canonical, positions, output)
    report['inputs'] = inputs
    report['final'] = len(inputs) == 2
    (output / 'month.json').write_text(dumps(report, indent=2, sort_keys=True) + '\n')
    summary = {k: v for k, v in report.items() if k not in ('days', 'objects')}
    summary['dayCount'] = len(report['days'])
    summary['totalBytes'] = sum(v['bytes'] for v in report['objects'].values())
    if upload:
        for key in report['objects']:
            r2.put_object(
                Bucket=bucket, Key=f'{prefix}/{key}', Body=(output / key).read_bytes(),
                ContentType='application/gzip' if key.endswith('.gz') else 'application/json',
                CacheControl='public, max-age=31536000, immutable',
            )
        index_key = f'{prefix}/index.json'
        try:
            index = loads(r2.get_object(Bucket=bucket, Key=index_key)['Body'].read())
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchKey':
                raise
            index = {'version': 1, 'days': {}, 'months': {}}
        if index['version'] != 1:
            raise ValueError('unsupported animation index version')
        index['days'].update(report['days'])
        index['months'][ym] = summary
        payload = dumps(index, indent=2, sort_keys=True).encode() + b'\n'
        r2.put_object(Bucket=bucket, Key=index_key, Body=payload, ContentType='application/json', CacheControl='public, max-age=60')
        (output / 'index.json').write_bytes(payload)
    print(dumps(summary, indent=2, sort_keys=True))
    return summary


def animation_months(value: str) -> list[str]:
    parts = value.split('-')
    if len(parts) != 2 or any(len(p) != 6 or not p.isdigit() for p in parts):
        raise UsageError('date must be YYYYMM-YYYYMM')
    first, last = [datetime.strptime(p, '%Y%m') for p in parts]
    if first > last:
        raise UsageError('date range must increase')
    months = []
    current = first
    while current <= last:
        months.append(current.strftime('%Y%m'))
        current = datetime(current.year + 1, 1, 1) if current.month == 12 else current.replace(month=current.month + 1)
    return months


@rides_anim.command('backfill')
@option('-d', '--date', 'date_range', required=True, help='Inclusive YYYYMM-YYYYMM source-start months.')
@option('-k', '--prefix', default='rides-anim-candidate/v1', show_default=True)
@option('-o', '--output', type=ClickPath(path_type=Path), default=Path('tmp/ride-animation-history'), show_default=True)
@option('-u', '--upload', is_flag=True, help='Publish each validated month; resume from matching index checkpoints.')
def backfill(
    date_range: str,
    prefix: str,
    output: Path,
    upload: bool,
) -> None:
    from .pyramid_cascade.rides_assets import _geo, _registry, effective_canonical
    from .pyramid_cascade.rides_source import station_positions
    # One writer merges the index; independent Batch array tasks must not
    # concurrently publish this mutable document.
    months = animation_months(date_range)
    canonical = effective_canonical()
    canonical_hash = md5(dumps(canonical, sort_keys=True).encode()).hexdigest()
    station_hash = md5(station_bytes(station_positions(_registry(), canonical, _geo()))).hexdigest()
    r2, bucket = _r2_client(rw=upload)
    index = {'months': {}}
    if upload:
        try:
            index = loads(r2.get_object(Bucket=bucket, Key=f'{prefix.rstrip("/")}/index.json')['Body'].read())
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchKey':
                raise
    for ym in months:
        previous = index['months'].get(ym)
        if upload and previous and previous.get('canonicalHash') == canonical_hash and previous['stations']['md5'] == station_hash and previous.get('final'):
            inputs = previous['inputs']
            if len(inputs) == 2 and all('key' in i and r2.head_object(Bucket=bucket, Key=i['key'])['ETag'] == i['etag'] for i in inputs):
                err(f'{ym}: validated checkpoint unchanged; skip')
                continue
        err(f'{ym}: building animation month')
        summary = create.callback(ym, None, prefix, output / ym, upload)
        index['months'][ym] = summary


@rides_anim.command('check')
@option('-b', '--baseline', default='rides-tl-fine', show_default=True)
@option('-i', '--input', 'input_dir', required=True, type=ClickPath(path_type=Path), help='Local build directory containing month.json.')
def check(baseline: str, input_dir: Path) -> None:
    from .pyramid_cascade.timelapse_check import daily_reference
    report = loads((input_dir / 'month.json').read_text())
    dates = sorted(report['days'])
    start = int(datetime.fromisoformat(dates[0]).replace(tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime.fromisoformat(dates[-1]).replace(tzinfo=timezone.utc).timestamp() * 1000) + 86400000
    r2, bucket = _r2_client()
    def get(key: str) -> bytes:
        return r2.get_object(Bucket=bucket, Key=key)['Body'].read()
    manifest = get(f'{baseline.rstrip("/")}/start/manifest.jsonl').decode()
    tier, totals = daily_reference(manifest, start, end, get)
    expected = {datetime.fromtimestamp(at / 1000, timezone.utc).strftime('%Y-%m-%d'): int(count) for at, count in totals.iter_rows()}
    actual = {day: meta['rides'] for day, meta in report['days'].items()}
    if actual != expected:
        raise ValueError(f'animation day counts differ: animation={actual}, pyramid={expected}')
    print(dumps({'days': len(dates), 'rides': sum(actual.values()), 'referenceTier': tier, 'exactDailyParity': True}, indent=2))


@rides_anim.command('check-index')
@option('-b', '--baseline', default='rides-tl-fine', show_default=True)
@option('-d', '--date', 'date_range', required=True, help='Inclusive YYYYMM-YYYYMM months to audit.')
@option('-k', '--prefix', default='rides-anim-candidate/v1', show_default=True)
@option('-o', '--output', type=ClickPath(path_type=Path), default=Path('tmp/animation-index-audit.json'))
def check_index(
    baseline: str,
    date_range: str,
    prefix: str,
    output: Path,
) -> None:
    from calendar import monthrange
    from functools import lru_cache
    from gzip import decompress
    from .ride_animation import decode_day
    from .ride_animation_audit import count_gate
    from .pyramid_cascade.timelapse_check import daily_reference
    r2, bucket = _r2_client()
    @lru_cache(maxsize=4)
    def get(key: str) -> bytes:
        return r2.get_object(Bucket=bucket, Key=key)['Body'].read()
    raw_index = get(f'{prefix.rstrip("/")}/index.json')
    index = loads(raw_index)
    if index['version'] != 1:
        raise ValueError('unsupported animation index version')
    manifest = get(f'{baseline.rstrip("/")}/start/manifest.jsonl').decode()
    results = {}
    for ym in animation_months(date_range):
        month = index['months'][ym]
        days = {day: meta for day, meta in index['days'].items() if day.replace('-', '').startswith(ym)}
        dates = sorted(days)
        expected_dates = [f'{ym[:4]}-{ym[4:]}-{day:02d}' for day in range(1, monthrange(int(ym[:4]), int(ym[4:]))[1] + 1)]
        if dates != expected_dates or month['dayCount'] != len(dates):
            raise ValueError(f'{ym}: animation month has missing or extra days')
        for item in month['inputs']:
            if 'key' not in item or 'etag' not in item:
                raise ValueError(f'{ym}: validation requires R2 input provenance')
            if r2.head_object(Bucket=bucket, Key=item['key'])['ETag'] != item['etag']:
                raise ValueError(f'{ym}: input changed after animation build')
        start = int(datetime.fromisoformat(dates[0]).replace(tzinfo=timezone.utc).timestamp() * 1000)
        end = int(datetime.fromisoformat(dates[-1]).replace(tzinfo=timezone.utc).timestamp() * 1000) + 86400000
        tier, totals = daily_reference(manifest, start, end, get)
        expected = {datetime.fromtimestamp(at / 1000, timezone.utc).strftime('%Y-%m-%d'): int(count) for at, count in totals.iter_rows()}
        # Empty days must be present in the animation's continuous month.
        expected = {day: expected.get(day, 0) for day in dates}
        result = count_gate(month, days, expected)
        samples = sorted({dates[0], dates[-1]})
        for day in samples:
            meta = days[day]
            blob = get(f'{prefix.rstrip("/")}/{meta["key"]}')
            if len(blob) != meta['bytes'] or md5(blob).hexdigest() != meta['md5']:
                raise ValueError(f'{day}: compressed object disagrees with indexed hash/size')
            nstations, carry, rows = decode_day(decompress(blob))
            station_blob = get(f'{prefix.rstrip("/")}/{meta["stations"]}')
            if md5(station_blob).hexdigest() != month['stations']['md5']:
                raise ValueError(f'{day}: station table hash disagrees with index')
            stations = loads(station_blob)
            if (nstations, carry, len(rows) - carry) != (len(stations), meta['carry'], meta['rides']):
                raise ValueError(f'{day}: decoded counts disagree with index')
        result.update(final=month['final'], referenceTier=tier, decodedSampleDays=samples)
        results[ym] = result
        err(f'{ym}: counts accounted; daily parity={result["exactDailyParity"]}; decoded {len(samples)} boundary days')
    report = {'version': 1, 'indexMd5': md5(raw_index).hexdigest(), 'prefix': prefix, 'baseline': baseline, 'months': results}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dumps(report, indent=2, sort_keys=True) + '\n')
    print(dumps({'months': len(results), 'sourceRides': sum(m['sourceRides'] for m in results.values()), 'encodedRides': sum(m['encodedRides'] for m in results.values()), 'excluded': sum(m['invalidDuration'] + m['unmapped'] for m in results.values()), 'exactDailyMonths': sum(m['exactDailyParity'] for m in results.values()), 'report': str(output)}, indent=2))


@rides_anim.command('submit')
@option('-d', '--date', 'date_range', required=True, help='Inclusive YYYYMM-YYYYMM source-start months.')
@option('-e', '--existing', is_flag=True, help='Submit through a matching pre-provisioned job definition; never register one.')
@option('-j', '--jobdef-only', is_flag=True, help='Provision the pinned job definition without submitting a build.')
@option('-k', '--prefix', default='rides-anim-candidate/v1', show_default=True)
@option('-m', '--memory', default=8192, type=int, show_default=True)
@option('-n', '--dry-run', is_flag=True, help='Print the build plan; register and submit nothing.')
@option('-r', '--assets-ref', default=None, help='Full commit SHA for current station-ID, registry, and geo assets; codec stays pinned.')
@option('-s', '--image', required=True, help='Pinned HCCS ctbk-reproc image containing the animation CLI.')
@option('-v', '--vcpus', default=4, type=int, show_default=True)
def submit(
    date_range: str,
    prefix: str,
    memory: int,
    dry_run: bool,
    image: str,
    vcpus: int,
    existing: bool = False,
    jobdef_only: bool = False,
    assets_ref: str | None = None,
) -> dict:
    import boto3
    import re
    from copy import deepcopy
    months = animation_months(date_range)
    if not re.fullmatch(r'688066488567\.dkr\.ecr\.us-east-1\.amazonaws\.com/ctbk-reproc:[a-f0-9]{8,40}', image):
        raise UsageError('use a pinned HCCS ctbk-reproc image')
    if vcpus not in (1, 2, 4, 8, 16) or memory < vcpus * 2048:
        raise UsageError('invalid Fargate resource request')
    if not prefix or prefix.startswith('/') or '..' in Path(prefix).parts:
        raise UsageError('prefix must be a relative bucket path')
    shell = f'exec ctbk rides-anim backfill -d {quote(date_range)} -k {quote(prefix)} -u'
    if assets_ref:
        if not re.fullmatch('[a-f0-9]{40}', assets_ref):
            raise UsageError('assets-ref must be a full commit SHA')
        shell = f'git fetch -q origin {assets_ref} && git checkout -q FETCH_HEAD -- s3/ctbk/stations/station-id-map.json www/public/assets/station-luc.json gbfs/engine/station-geo.json && {shell}'
    command = ['script', shell]
    plan = {'queue': 'ctbk-reproc', 'image': image, 'months': len(months), 'vcpus': vcpus, 'memory': memory, 'command': command}
    if existing and jobdef_only:
        raise UsageError('existing and jobdef-only are mutually exclusive')
    if existing:
        plan['useExistingJobDefinition'] = True
    if jobdef_only:
        plan['provisionOnly'] = True
    if assets_ref:
        plan['assetsRef'] = assets_ref
    if dry_run:
        print(dumps(plan, indent=2))
        return plan
    if boto3.client('sts').get_caller_identity()['Account'] != '688066488567':
        raise UsageError('submit requires the HCCS AWS account')
    batch = boto3.client('batch', region_name='us-east-1')
    if existing:
        definitions = batch.describe_job_definitions(jobDefinitionName='ctbk-reproc-animation', status='ACTIVE')['jobDefinitions']
        candidates = [definition for definition in definitions if definition['containerProperties']['image'] == image]
        if not candidates:
            raise UsageError('provision the pinned animation job definition with `rides-anim submit -j` first')
        definition = max(candidates, key=lambda definition: definition['revision'])
        job = batch.submit_job(
            jobName=f'rides-anim-{months[0]}-{months[-1]}', jobQueue='ctbk-reproc',
            jobDefinition=definition['jobDefinitionArn'],
            containerOverrides={'command': command, 'resourceRequirements': [{'type': 'VCPU', 'value': str(vcpus)}, {'type': 'MEMORY', 'value': str(memory)}]},
        )
        result = {'jobId': job['jobId'], 'jobDefinition': definition['jobDefinitionArn'], **plan}
        print(dumps(result, indent=2))
        return result
    defs = batch.describe_job_definitions(jobDefinitionName='ctbk-reproc', status='ACTIVE')['jobDefinitions']
    latest = max(defs, key=lambda d: d['revision'])
    props = deepcopy(latest['containerProperties'])
    props['image'] = image
    props['resourceRequirements'] = [{'type': 'VCPU', 'value': str(vcpus)}, {'type': 'MEMORY', 'value': str(memory)}]
    names = {'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'}
    props['secrets'] = [s for s in props.get('secrets', []) if s['name'] in names]
    if {s['name'] for s in props['secrets']} != names:
        raise UsageError('base job definition must bind the R2 pair from Secrets Manager')
    props['environment'] = [e for e in props.get('environment', []) if e['name'] not in names | {'FARGATE_GITHUB_RW_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'DVX_PUSH_REMOTE'}] + [
        {'name': 'CLOUDFLARE_ACCOUNT_ID', 'value': '2363642879f18d37d52dca114059937e'},
        {'name': 'DVX_PUSH_REMOTE', 'value': 'none'},
    ]
    props['command'] = command
    definition = batch.register_job_definition(
        jobDefinitionName='ctbk-reproc-animation', type='container', containerProperties=props,
        platformCapabilities=latest.get('platformCapabilities', ['FARGATE']),
        retryStrategy={'attempts': 3, 'evaluateOnExit': [
            {'onStatusReason': 'Your Spot Task*', 'action': 'RETRY'},
            {'onStatusReason': 'Host EC2*', 'action': 'RETRY'}, {'onReason': '*', 'action': 'EXIT'},
        ]},
    )
    if jobdef_only:
        result = {'jobDefinition': definition['jobDefinitionArn'], 'submitted': False, **plan}
        print(dumps(result, indent=2))
        return result
    job = batch.submit_job(
        jobName=f'rides-anim-{months[0]}-{months[-1]}', jobQueue='ctbk-reproc',
        jobDefinition=definition['jobDefinitionArn'],
    )
    result = {'jobId': job['jobId'], 'jobDefinition': definition['jobDefinitionArn'], **plan}
    print(dumps(result, indent=2))
    return result


def animation_assets_ref() -> str:
    from subprocess import check_output
    from .pyramid_cascade.rides_assets import REPO
    return check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()


@rides_anim.command('extend')
@option('-d', '--date', 'ym', required=True, help='Newly ingested end month, YYYYMM; rebuild its preceding start month too.')
@option('-k', '--prefix', default='rides-anim-candidate/v1', show_default=True)
@option('-n', '--dry-run', is_flag=True)
@option('-s', '--image', default='688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:1a7fdd1d', show_default=True)
def extend(
    ym: str,
    prefix: str,
    dry_run: bool,
    image: str,
) -> None:
    from click import get_current_context
    from .gbfs_cli import gbfs_engine_watch
    if len(ym) != 6 or not ym.isdigit():
        raise UsageError('date must be YYYYMM')
    month = datetime.strptime(ym, '%Y%m')
    previous = datetime(month.year - 1, 12, 1) if month.month == 1 else month.replace(month=month.month - 1)
    date_range = f'{previous:%Y%m}-{month:%Y%m}'
    if not dry_run:
        import boto3
        batch = boto3.client('batch', region_name='us-east-1')
        # One writer merges the mutable candidate index. Monthly GHA is
        # serialized too; detect independently submitted backfills here.
        for status in ('SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'):
            pager = batch.get_paginator('list_jobs')
            for page in pager.paginate(jobQueue='ctbk-reproc', jobStatus=status):
                if any(job['jobName'].startswith('rides-anim-') for job in page['jobSummaryList']):
                    raise UsageError('an animation writer is already active; retry after its completion')
    result = submit.callback(date_range, prefix, 8192, dry_run, image, 4, existing=True, assets_ref=animation_assets_ref())
    if dry_run:
        return
    get_current_context().invoke(gbfs_engine_watch, interval=20, timeout=3600, job_ids=(result['jobId'],))
    check_index.callback('rides-tl-fine', date_range, prefix, Path('tmp/animation-extend-audit.json'))
