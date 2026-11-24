"""Raw GBFS JSON retention: `ctbk gbfs raw-gc`.

Each closed day's minute JSONs are compacted into `gbfs/status/<day>.parquet`
(`gbfs/compact-r2.py`), the source of truth for every derived avail tier. The
JSONs themselves (~3 GB/day across the three prefixes below) are kept only
`--keep-days` back, and a day's JSONs are deleted only once the parquet is
verified to hold every LU they recorded:

- WAL aliases `gbfs/status/<day>/<HH-MM>.json`: each file's `ts` (read from
  its first bytes) must be one of the parquet's `ts` values.
- Generations `gbfs/status-generation/<day>/<ts>.json`: the `ts` in the name
  must be in the parquet. A same-LU content variant (`<ts>-<sha256>.json`)
  never enters the parquet; it's copied to `gbfs/status-variants/<day>/`
  (which has no retention) before deletion.
- 1.1 backup polls `gbfs/probe/v11/<day>/<HH-MM>.json` (LU-minute keys): the
  parquet must hold an LU in that minute — either the fill itself, or the 2.3
  capture that made the fill unnecessary.

Any other file shape, a missing parquet, or a single uncovered JSON leaves
the whole day untouched and fails the run. Before deleting, a manifest
`gbfs/raw-gc/<day>.json` records what was removed and the day's 1.1-filled
minutes, which `gbfs_empty.filled_minutes` otherwise derives from the
listings this deletes.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from click import argument, option
from utz import err

from ctbk.gbfs_cli import _r2_creds, gbfs

WAL_PREFIX = 'gbfs/status'
GENERATION_PREFIX = 'gbfs/status-generation'
V11_PREFIX = 'gbfs/probe/v11'
VARIANT_PREFIX = 'gbfs/status-variants'
MANIFEST_PREFIX = 'gbfs/raw-gc'
RAW_PREFIXES = (WAL_PREFIX, GENERATION_PREFIX, V11_PREFIX)

MINUTE_RE = re.compile(r'(\d\d)-(\d\d)\.json')
GEN_RE = re.compile(r'(\d+)\.json')
VARIANT_RE = re.compile(r'(\d+)-[0-9a-f]{64}\.json')
DAY_RE = re.compile(r'\d{4}-\d\d-\d\d')
HEAD_TS_RE = re.compile(rb'\{\s*"ts"\s*:\s*(\d+)')


def manifest_key(day: str) -> str:
    return f'{MANIFEST_PREFIX}/{day}.json'


def variant_key(day: str, name: str) -> str:
    return f'{VARIANT_PREFIX}/{day}/{name}'


def minute_of(ts: int) -> int:
    return (ts % 86400) // 60


@dataclass
class DayPlan:
    day: str
    # Deletion order: v11 before generations before WAL, so a run interrupted
    # mid-day never leaves v11 keys without the WAL listing that
    # `filled` is computed against (a rerun unions with the prior manifest).
    delete: list[str] = field(default_factory=list)
    variants: list[str] = field(default_factory=list)
    filled: list[int] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)


def plan_day(
    day: str,
    parquet_ts: set[int] | None,
    wal: dict[str, int],
    generations: list[str],
    v11: list[str],
) -> DayPlan:
    """What to delete for `day`, or why not. `parquet_ts` is the daily
    parquet's `ts` set (None: no parquet); `wal` maps each WAL alias key to
    the `ts` it records; `generations` / `v11` are keys."""
    plan = DayPlan(day)
    if parquet_ts is None:
        plan.problems.append(f'no {WAL_PREFIX}/{day}.parquet')
        return plan
    pq_minutes = {minute_of(t) for t in parquet_ts}

    wal_minutes = set()
    for k, ts in sorted(wal.items()):
        name = k.rsplit('/', 1)[1]
        if not (m := MINUTE_RE.fullmatch(name)):
            plan.problems.append(f'unexpected WAL key {k}')
        elif ts not in parquet_ts:
            plan.problems.append(f'{k}: ts {ts} not in parquet')
        else:
            wal_minutes.add(int(m[1]) * 60 + int(m[2]))

    gen_delete = []
    for k in sorted(generations):
        name = k.rsplit('/', 1)[1]
        if m := GEN_RE.fullmatch(name):
            if int(m[1]) not in parquet_ts:
                plan.problems.append(f'{k}: ts not in parquet')
            gen_delete.append(k)
        elif VARIANT_RE.fullmatch(name):
            plan.variants.append(k)
            gen_delete.append(k)
        else:
            plan.problems.append(f'unexpected generation key {k}')

    v11_delete, filled = [], set()
    for k in sorted(v11):
        name = k.rsplit('/', 1)[1]
        if not (m := MINUTE_RE.fullmatch(name)):
            plan.problems.append(f'unexpected v11 key {k}')
            continue
        minute = int(m[1]) * 60 + int(m[2])
        if minute not in pq_minutes:
            plan.problems.append(f'{k}: no parquet LU in that minute')
        if minute not in wal_minutes:
            filled.add(minute)
        v11_delete.append(k)

    if plan.problems:
        return plan
    plan.delete = [*v11_delete, *gen_delete, *sorted(wal)]
    plan.filled = sorted(filled)
    plan.counts = {'wal': len(wal), 'generations': len(gen_delete), 'v11': len(v11_delete)}
    return plan


def merge_manifest(prior: dict | None, plan: DayPlan, parquet: dict, nbytes: int, now: str) -> dict:
    """The day's manifest after this run, accumulated over any prior partial run."""
    prior = prior or {}
    counts = dict(prior.get('deleted', {}))
    for k, n in plan.counts.items():
        counts[k] = counts.get(k, 0) + n
    return {
        'day': plan.day,
        'parquet': parquet,
        'deleted': counts,
        'bytes': prior.get('bytes', 0) + nbytes,
        'variants': sorted({*prior.get('variants', []), *(variant_key(plan.day, k.rsplit('/', 1)[1]) for k in plan.variants)}),
        'filled': sorted({*prior.get('filled', []), *plan.filled}),
        'runs': [*prior.get('runs', []), now],
    }


def gc_days(today: date, keep_days: int, raw_days: set[str]) -> list[str]:
    """Days with raw JSON older than the retention window, oldest first."""
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    return sorted(d for d in raw_days if d < cutoff)


class R2:
    def __init__(self, jobs: int):
        import boto3
        from botocore.config import Config
        acct, akid, sk = _r2_creds(rw=True)
        self.endpoint = f'https://{acct}.r2.cloudflarestorage.com'
        self.akid, self.sk = akid, sk
        self.bucket = 'ctbk'
        self.cli = boto3.client(
            's3', endpoint_url=self.endpoint, aws_access_key_id=akid, aws_secret_access_key=sk,
            region_name='auto', config=Config(max_pool_connections=max(jobs, 10), retries={'max_attempts': 8, 'mode': 'adaptive'}),
        )
        self.pool = ThreadPoolExecutor(jobs)

    def day_prefixes(self, prefix: str) -> set[str]:
        days = set()
        for page in self.cli.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=f'{prefix}/', Delimiter='/'):
            for cp in page.get('CommonPrefixes', []):
                d = cp['Prefix'][len(prefix) + 1:].rstrip('/')
                if DAY_RE.fullmatch(d):
                    days.add(d)
        return days

    def ls(self, prefix: str) -> dict[str, int]:
        out = {}
        for page in self.cli.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=prefix):
            for o in page.get('Contents', []):
                out[o['Key']] = o['Size']
        return out

    def parquet_ts(self, day: str) -> tuple[set[int], dict] | None:
        import pyarrow.compute as pc
        import pyarrow.parquet as pq
        from pyarrow.fs import S3FileSystem
        key = f'{WAL_PREFIX}/{day}.parquet'
        try:
            head = self.cli.head_object(Bucket=self.bucket, Key=key)
        except self.cli.exceptions.ClientError as e:
            if e.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                return None
            raise
        fs = S3FileSystem(endpoint_override=self.endpoint, access_key=self.akid, secret_key=self.sk, region='auto')
        ts = pq.read_table(f'{self.bucket}/{key}', columns=['ts'], filesystem=fs)['ts']
        uniq = set(pc.unique(ts).to_pylist())
        return uniq, {'key': key, 'etag': head['ETag'].strip('"'), 'size': head['ContentLength'], 'rows': len(ts), 'lus': len(uniq)}

    def head_ts(self, key: str) -> int:
        body = self.cli.get_object(Bucket=self.bucket, Key=key, Range='bytes=0-63')['Body'].read()
        if m := HEAD_TS_RE.match(body):
            return int(m[1])
        return int(json.loads(self.cli.get_object(Bucket=self.bucket, Key=key)['Body'].read())['ts'])

    def get_json(self, key: str) -> dict | None:
        try:
            return json.loads(self.cli.get_object(Bucket=self.bucket, Key=key)['Body'].read())
        except self.cli.exceptions.NoSuchKey:
            return None

    def put_json(self, key: str, doc: dict) -> None:
        self.cli.put_object(Bucket=self.bucket, Key=key, Body=json.dumps(doc, indent=1).encode(), ContentType='application/json')

    def copy_verified(self, src: str, dst: str) -> None:
        self.cli.copy_object(Bucket=self.bucket, Key=dst, CopySource={'Bucket': self.bucket, 'Key': src})
        a = self.cli.head_object(Bucket=self.bucket, Key=src)
        b = self.cli.head_object(Bucket=self.bucket, Key=dst)
        if (a['ETag'], a['ContentLength']) != (b['ETag'], b['ContentLength']):
            raise RuntimeError(f'copy {src} → {dst}: etag/size mismatch')

    def delete(self, keys: list[str]) -> None:
        for i in range(0, len(keys), 1000):
            chunk = keys[i:i + 1000]
            resp = self.cli.delete_objects(Bucket=self.bucket, Delete={'Objects': [{'Key': k} for k in chunk], 'Quiet': True})
            if errs := resp.get('Errors'):
                raise RuntimeError(f'delete_objects: {len(errs)} errors, e.g. {errs[0]}')


def gc_day(r2: R2, day: str, dry_run: bool) -> tuple[DayPlan, int]:
    listings = {p: r2.ls(f'{p}/{day}/') for p in RAW_PREFIXES}
    wal_keys = [k for k in listings[WAL_PREFIX] if k.endswith('.json')]
    pq = r2.parquet_ts(day)
    wal = dict(zip(wal_keys, r2.pool.map(r2.head_ts, wal_keys))) if pq else {k: -1 for k in wal_keys}
    plan = plan_day(day, pq[0] if pq else None, wal, list(listings[GENERATION_PREFIX]), list(listings[V11_PREFIX]))
    doomed = set(plan.delete)
    nbytes = sum(size for listing in listings.values() for k, size in listing.items() if k in doomed)
    if plan.problems or dry_run or not plan.delete:
        return plan, nbytes
    for k in plan.variants:
        r2.copy_verified(k, variant_key(day, k.rsplit('/', 1)[1]))
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    r2.put_json(manifest_key(day), merge_manifest(r2.get_json(manifest_key(day)), plan, pq[1], nbytes, now))
    r2.delete(plan.delete)
    return plan, nbytes


@gbfs.command('raw-gc', help='Delete raw GBFS minute JSONs (WAL aliases, generations, 1.1 backup polls) for days older than the retention window, each day only after verifying its daily `gbfs/status/<day>.parquet` holds every LU they recorded; same-LU content variants move to `gbfs/status-variants/`, and a `gbfs/raw-gc/<day>.json` manifest records each deletion. Exits 1 if any day fails verification (that day is left untouched). `ctbk/gbfs_raw_gc.py`.')
@option('-j', '--jobs', type=int, default=48, help='Concurrent range GETs (WAL `ts` reads).')
@option('-k', '--keep-days', type=int, default=90, help='Retain this many days of raw JSON before today (UTC).')
@option('-m', '--max-days', type=int, help='GC at most this many (oldest) days this run.')
@option('-n', '--dry-run', is_flag=True, help='Verify and report; copy/write/delete nothing.')
@argument('days', nargs=-1)
def raw_gc(jobs: int, keep_days: int, max_days: int | None, dry_run: bool, days: tuple[str, ...]) -> None:
    r2 = R2(jobs)
    today = datetime.now(timezone.utc).date()
    raw_days = set().union(*(r2.day_prefixes(p) for p in RAW_PREFIXES))
    todo = gc_days(today, keep_days, raw_days)
    if days:
        if bad := sorted(set(days) - set(todo)):
            raise SystemExit(f'not GC-eligible (no raw JSON, or within {keep_days}d): {" ".join(bad)}')
        todo = sorted(days)
    if max_days is not None:
        todo = todo[:max_days]
    err(f'{len(todo)} day(s) to GC (keep {keep_days}d, cutoff {today - timedelta(days=keep_days)}){" [dry run]" if dry_run else ""}')
    failed, total = [], 0
    print('day\tstatus\twal\tgenerations\tv11\tvariants\tfilled\tGB')
    for day in todo:
        plan, nbytes = gc_day(r2, day, dry_run)
        if plan.problems:
            failed.append(day)
            err(f'{day}: {len(plan.problems)} problem(s), e.g. {plan.problems[:3]}')
            print(f'{day}\tFAIL\t\t\t\t\t\t')
            continue
        total += nbytes
        c = plan.counts
        status = 'empty' if not plan.delete else ('ok' if dry_run else 'deleted')
        print(f'{day}\t{status}\t{c.get("wal", 0)}\t{c.get("generations", 0)}\t{c.get("v11", 0)}\t{len(plan.variants)}\t{len(plan.filled)}\t{nbytes / 1e9:.2f}', flush=True)
    err(f'{"would free" if dry_run else "freed"} {total / 1e9:.1f} GB over {len(todo) - len(failed)} day(s); {len(failed)} failed{": " + " ".join(failed) if failed else ""}')
    if failed:
        raise SystemExit(1)
