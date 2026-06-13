#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["click", "requests", "utz"]
# ///
"""Probe the worker's `/api/d1-probe` endpoint to characterize D1 cold/warm
latency from CFW workers.

Use `--mode` to select what to time:
  raw         — bare `env.RIDES_V3_COARSE.prepare(sql).bind(...).all()`
  d1Backend   — same call, but via pyrmts-cfw's `d1Backend.fetchSegment(...)`
  pyramid     — call goes through `withDimCodec(d1Backend(...))` (the real
                worker shape) via `ridesPyramidV3D1(db, 'start').storage`

Key observation: WITHIN a single worker invocation, the FIRST `.all()` is
~370ms-5s, subsequent calls are ~20-50ms. So `-n 5` shows the cold/warm split
within one invocation. Across-invocation cold also pays the ~5s start (each
fresh URL = fresh worker context).
"""
from __future__ import annotations

import json
import sys

import click
import requests
from utz import err


@click.command()
@click.option('--api-base', '-A', default='https://ctbk-gbfs-api-dev.ryan-0dc.workers.dev',
              help='Worker base URL.')
@click.option('--mode', '-m', default='raw',
              type=click.Choice(['raw', 'd1Backend', 'pyramid']),
              help='Which call path to time.')
@click.option('--table', '-t', default='rides_start_1d',
              help='D1 table (default 1d tier, what the bench actually hits).')
@click.option('--limit', '-l', default=1080, type=int,
              help='LIMIT N (raw mode only; backends ignore).')
@click.option('--repeats', '-n', default=5, type=int,
              help='Sequential calls per invocation (shows cold-vs-warm).')
@click.option('--invocations', '-I', default=1, type=int,
              help='Number of fresh worker invocations (each is its own cold).')
@click.option('--cells', '-c',
              default='89c2f5,89c259,89c25d,89c2f7,89c25b,89c25f,89c2f3,89c245,89c24f',
              help='Comma-separated cell IN-set (default = NYC mixed cover).')
@click.option('--dt-from', default='1761955200000', help='UNIX ms start.')
@click.option('--dt-to', default='1764547200000', help='UNIX ms end.')
@click.option('--sql', default=None, help='Custom SQL (raw mode only).')
def main(api_base: str, mode: str, table: str, limit: int, repeats: int,
         invocations: int, cells: str, dt_from: str, dt_to: str, sql: str | None):
    params: dict[str, str | int] = {
        'n': repeats,
        'table': table,
        'limit': limit,
        'cells': cells,
        'dt_from': dt_from,
        'dt_to': dt_to,
    }
    if mode == 'd1Backend':
        params['backend'] = 1
    elif mode == 'pyramid':
        params['pyramid'] = 1
    if sql:
        params['sql'] = sql

    url = f'{api_base.rstrip("/")}/api/d1-probe'

    all_runs: list[dict] = []
    colos: list[dict] = []
    for inv in range(invocations):
        # Force-new invocation by adding a unique cache-buster — same URL =
        # same edge cache key = subsequent hits would HIT instead of MISS.
        # `/api/d1-probe` doesn't cache today, but be defensive.
        params['_cb'] = f'{inv}-{repeats}'
        resp = requests.get(url, params=params, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        colos.append({
            'invocation': inv,
            'workerColo': data.get('workerColo'),
            'd1Colo': data.get('d1Colo'),
        })
        for run in data.get('runs', []):
            run['invocation'] = inv
            run['workerColo'] = data.get('workerColo')
            run['d1Colo'] = data.get('d1Colo')
            all_runs.append(run)

    print(json.dumps({
        'mode': mode,
        'table': table,
        'sql': data.get('sql'),
        'colos': colos,
        'runs': all_runs,
    }, indent=2))

    err()
    err(f"{'inv':>3s} {'worker':>6s} {'d1':>4s} {'call':>4s} {'wall_ms':>9s} {'rows':>6s} {'sql_ms':>7s} mode")
    err('-' * 60)
    for r in all_runs:
        sql_ms = r.get('sqlDurationMs')
        sql_ms_str = f'{sql_ms:.2f}' if sql_ms is not None else '—'
        wc = r.get('workerColo') or '—'
        dc = r.get('d1Colo') or '—'
        err(f"{r['invocation']:>3d} {wc:>6s} {dc:>4s} {r['run']:>4d} "
            f"{r['wallMs']:>9.1f} {r['rows']:>6d} {sql_ms_str:>7s} {r['mode']}")


if __name__ == '__main__':
    main()
