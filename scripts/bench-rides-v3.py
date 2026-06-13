#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["click", "requests", "utz"]
# ///
"""Benchmark the rides-v3 API: parquet vs D1 backends, cold vs warm.

Drives the rides-v3 endpoint at multiple (region, duration) combinations,
each in 3 modes:
  - cold parquet  (`?nocache=1` or fresh cache buster, no `backend`)
  - warm parquet  (re-fetch same URL → edge HIT)
  - cold D1       (`?backend=d1&nocache=1`)
  - warm D1       (`?backend=d1`)

Regions are pulled from R2 (`r2://ctbk/region-cells/v3/<region>.json`).
A synthetic 200-cell "neighborhood" cover is also included for parity
with planned UX patterns.

Output: JSONL (one row per measurement) + a Markdown summary table.

Cache control
-------------
`/api/rides-v3` uses `caches.default` (edge cache) keyed by full URL.
- Force cold: append `&_cb=<uuid>` (or use `Cache-Control: no-cache` request
  header — though the worker bypass code may not honor it).
- Force warm: hit a stable URL twice; the second hit returns
  `X-Cache: HIT`.
- The `cf-cache-status` header (set by CF, not our worker) also reports
  edge-cache state.

Run
---
  bench-rides-v3.py \\
      --api-base https://ctbk-gbfs-api.<account>.workers.dev \\
      --out tmp/bench-rides-v3.jsonl

For the dev worker (after `wrangler deploy --env dev`):
  --api-base https://ctbk-gbfs-api-dev.ryan-0dc.workers.dev
"""
from __future__ import annotations

import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

import click
import requests
from utz import err


Backend = Literal['parquet', 'd1']
CacheMode = Literal['cold', 'warm']

DEFAULT_DURATIONS = ('1mo', '6mo', '1y', '5y', '13y')


def duration_range(dur: str, anchor: datetime) -> tuple[datetime, datetime]:
    """Resolve a duration label into (from, to) with `to=anchor`."""
    if dur.endswith('mo'):
        n = int(dur[:-2])
        from_ = anchor.replace(year=anchor.year - (n // 12), month=((anchor.month - 1 - (n % 12)) % 12) + 1)
        if (anchor.month - 1 - (n % 12)) < 0:
            from_ = from_.replace(year=from_.year - 1)
    elif dur.endswith('y'):
        n = int(dur[:-1])
        from_ = anchor.replace(year=anchor.year - n)
    elif dur.endswith('d'):
        n = int(dur[:-1])
        from_ = anchor - timedelta(days=n)
    else:
        raise click.BadParameter(f"can't parse duration {dur!r}")
    return from_, anchor


_REGION_CELLS_CACHE: dict | None = None


def fetch_region_cells(region: str, r2_base: str) -> list[str]:
    """Pull a v3 region's minimal cover.

    The cover lives in the FE bundle at `/assets/region-cells-s2.json` (a
    `{REGION: [cells...]}` dict). `r2_base` is repurposed as the base host
    for that asset — pass the FE origin (https://ctbk.dev) or any
    deployment that serves the same asset."""
    global _REGION_CELLS_CACHE
    if _REGION_CELLS_CACHE is None:
        url = f'{r2_base.rstrip("/")}/assets/region-cells-s2.json'
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        _REGION_CELLS_CACHE = resp.json()
    upper = region.upper()
    for k in (region, upper, region.lower()):
        if k in _REGION_CELLS_CACHE:
            return list(_REGION_CELLS_CACHE[k])
    return []


def synthetic_neighborhood(n_cells: int = 200) -> list[str]:
    """Deterministic ~200-cell S2 token list — uses a known NYC center +
    a grid of L14 cells around it. Fallback for when region-cells aren't
    available."""
    # NYC subset known to be populated. These are stub tokens; for a
    # real synthetic neighborhood, regen via `ctbk region-cells` against
    # an arbitrary station subset. Listed here as a TODO.
    return []  # populated after region-cells endpoint is up


def one_request(
    api_base: str,
    region: str,
    cells: list[str],
    from_: datetime,
    to: datetime,
    backend: Backend,
    cache_mode: CacheMode,
    bin_budget: int = 200,
    cell_budget: int = 16,
    cells_exclude: list[str] | None = None,
    run_tag: str | None = None,
) -> dict:
    params = {
        'from': from_.isoformat(),
        'to': to.isoformat(),
        'bin_budget': bin_budget,
        'cell_budget': cell_budget,
        'cells': ','.join(cells),
        'anchor': 'start',
        # Provide a bbox covering the whole NYC region — needed even with
        # explicit cells (planner uses it for outputRes fallback).
        'bbox': '40.5,-74.3,40.95,-73.7',
    }
    if cells_exclude:
        params['cells.exclude'] = ','.join(cells_exclude)
    # Per-run tag busts CFW edge cache across bench runs — without it, a
    # stable URL across runs picks up the prior run's cached body (so
    # warm latency reflects a stale payload, e.g. an old buggy worker
    # version). Keeps cold/warm semantics within the run.
    if run_tag:
        params['_run'] = run_tag
    if backend == 'd1':
        params['backend'] = 'd1'
    if cache_mode == 'cold':
        params['_cb'] = uuid.uuid4().hex
    url = f'{api_base.rstrip("/")}/api/rides-v3'

    t0 = time.perf_counter()
    resp = requests.get(url, params=params, timeout=60, headers={
        'Accept-Encoding': 'gzip',
    })
    dt_ms = (time.perf_counter() - t0) * 1000

    bytes_in = int(resp.headers.get('Content-Length') or 0) or len(resp.content)
    return {
        'region': region,
        'duration': (to - from_).days,
        'n_cells': len(cells),
        'backend': backend,
        'cache_mode': cache_mode,
        'status': resp.status_code,
        'latency_ms': round(dt_ms, 1),
        'bytes': bytes_in,
        'x_cache': resp.headers.get('X-Cache') or '',
        'cf_cache_status': resp.headers.get('cf-cache-status') or '',
        'worker_colo': resp.headers.get('X-Worker-Colo') or '',
        'server_timing': resp.headers.get('server-timing') or '',
        'url': resp.url,
    }


@click.command()
@click.option('--api-base', '-A', required=True, help='Worker base URL.')
@click.option('--r2-base', '-R', default='https://ctbk.dev',
              help='Base URL serving `/assets/region-cells-s2.json`.')
@click.option('--regions', '-r', default='nyc,jc,hob,neighborhood',
              help='Comma-separated region names (default nyc,jc,hob,neighborhood).')
@click.option('--durations', '-d', default=','.join(DEFAULT_DURATIONS),
              help='Comma-separated durations (e.g. 1mo,6mo,1y,5y,13y).')
@click.option('--anchor-date', default=None,
              help='Anchor `to` date (ISO; default = first of current month UTC).')
@click.option('--repeats', '-n', default=3, type=int,
              help='Repeat each measurement N times; median taken.')
@click.option('--backends', '-b', default='parquet,d1',
              help='Backends to test.')
@click.option('--out', '-o', required=True, help='Output JSONL path.')
@click.option('--covers-file', '-c', default=None,
              help='Path to a JSON `{REGION: {include, exclude}}` file (FE-style '
                   'mixed-level cover). Overrides flat region-cells.')
def main(
    api_base: str,
    r2_base: str,
    regions: str,
    durations: str,
    anchor_date: str | None,
    repeats: int,
    backends: str,
    out: str,
    covers_file: str | None,
):
    region_list = [r.strip() for r in regions.split(',')]
    dur_list = [d.strip() for d in durations.split(',')]
    backend_list = [b.strip() for b in backends.split(',')]
    anchor = (datetime.fromisoformat(anchor_date).replace(tzinfo=timezone.utc)
              if anchor_date
              else datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0))

    # Resolve cells per region (sync now; cache).
    cells_by_region: dict[str, list[str]] = {}
    excludes_by_region: dict[str, list[str]] = {}
    covers_data: dict[str, dict] | None = None
    if covers_file:
        with open(covers_file) as f:
            covers_data = json.load(f)
        err(f"  loaded mixed-level covers from {covers_file}")
    for r in region_list:
        if r == 'neighborhood':
            cells_by_region[r] = synthetic_neighborhood()
            continue
        if covers_data:
            upper = r.upper()
            cov = covers_data.get(upper) or covers_data.get(r) or covers_data.get(r.lower())
            if cov is None:
                err(f"  WARN {r}: not in covers file; skipping")
                cells_by_region[r] = []
                continue
            cells_by_region[r] = list(cov.get('include', []))
            excludes_by_region[r] = list(cov.get('exclude', []))
            err(f"  {r}: {len(cells_by_region[r])} include + {len(excludes_by_region[r])} exclude (mixed)")
            continue
        try:
            cells_by_region[r] = fetch_region_cells(r, r2_base)
            err(f"  {r}: {len(cells_by_region[r])} cells (flat)")
        except Exception as e:
            err(f"  WARN {r}: failed to fetch cells ({e}); skipping")
            cells_by_region[r] = []

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_tag = uuid.uuid4().hex[:8]
    err(f"run_tag={run_tag}")

    measurements: list[dict] = []
    with out_path.open('w') as f:
        for region in region_list:
            cells = cells_by_region.get(region, [])
            if not cells:
                continue
            for dur in dur_list:
                from_, to = duration_range(dur, anchor)
                for backend in backend_list:
                    # Cold + warm pair per (region, duration, backend).
                    for cache_mode in ('cold', 'warm'):
                        for rep in range(repeats):
                            m = one_request(
                                api_base, region, cells, from_, to,
                                backend=backend,  # type: ignore[arg-type]
                                cache_mode=cache_mode,  # type: ignore[arg-type]
                                cells_exclude=excludes_by_region.get(region),
                                run_tag=run_tag,
                            )
                            m['rep'] = rep
                            m['from'] = from_.isoformat()
                            m['to'] = to.isoformat()
                            m['duration_label'] = dur
                            measurements.append(m)
                            f.write(json.dumps(m) + '\n')
                            f.flush()
                            err(f"  {region:12s} {dur:5s} {backend:7s} {cache_mode:4s} "
                                f"#{rep}: {m['latency_ms']:>6.1f} ms "
                                f"({m['bytes']:>6,} B, {m['x_cache'] or m['cf_cache_status']}, "
                                f"worker={m['worker_colo'] or '?'})")

    # Summary table.
    err()
    err("=== Summary (median per cell) ===")
    err()
    err(f"{'region':12s} {'duration':5s} {'backend':7s} {'mode':5s} {'median_ms':>10s} {'bytes':>8s}")
    err('-' * 60)
    from statistics import median
    by_key: dict[tuple[str, str, str, str], list[dict]] = {}
    for m in measurements:
        k = (m['region'], m['duration_label'], m['backend'], m['cache_mode'])
        by_key.setdefault(k, []).append(m)
    for (region, dur, backend, mode), rows in sorted(by_key.items()):
        latencies = [r['latency_ms'] for r in rows if r['status'] == 200]
        if not latencies:
            err(f"{region:12s} {dur:5s} {backend:7s} {mode:5s} {'ALL FAIL':>10s}")
            continue
        med = median(latencies)
        size = max(r['bytes'] for r in rows)
        err(f"{region:12s} {dur:5s} {backend:7s} {mode:5s} {med:>10.1f} {size:>8,}")

    err()
    err(f"wrote {out_path} ({len(measurements)} measurements)")


if __name__ == '__main__':
    main()
