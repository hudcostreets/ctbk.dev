"""Phase 0 of the `pyrmts-d1-backend` spec: empirical sizing of rides-v{1,2,3}
pyramid shards, and parquet↔SQLite ratio measurement for the proposed D1 schema.

Two subcommands:

* `ctbk pyramid-stats`: enumerate R2 shards, emit per
  (variant, anchor, tier, level, shard) JSONL with
  `{ bytes, rows, distinct_cells, distinct_dts, distinct_dim_combos }`.

* `ctbk d1-size-probe`: for representative tiers, materialize the parquet into
  a single SQLite table (one per `(variant, anchor, tier)`, mirroring the spec's
  `CREATE TABLE rides_<anchor>_<tier> (... PRIMARY KEY (cell, dt, gender, user_type,
  bike_type)) WITHOUT ROWID;`), VACUUM, and report sizes.
"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable, Literal

import boto3
import h3
import pandas as pd
import s2cell
from click import BadParameter, argument, option
from utz import err
from utz.cli import flag

from ctbk.cli.base import ctbk
from ctbk.rides_v1 import (
    ANCHORS, Anchor, DIM_COLS, MONOID_COLS, R2_BUCKET, VARIANTS, Variant,
    cell_col as rides_cell_col, r2_client, tier_specs,
)


# ─── Shard inventory on R2 ─────────────────────────────────────────────

def list_shards(
    cli,
    variants: tuple[Variant, ...],
    anchors: tuple[Anchor, ...],
    tiers: tuple[str, ...] | None,
) -> list[dict]:
    """Return per-shard descriptors for every parquet under `rides-v{variant}/`.

    Each item: `{ variant, anchor, tier, period, key, bytes }`.
    """
    out: list[dict] = []
    paginator = cli.get_paginator('list_objects_v2')
    for v in variants:
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=f'rides-{v}/'):
            for o in page.get('Contents', []):
                key = o['Key']
                if not key.endswith('.parquet'):
                    continue
                parts = key.split('/')
                if len(parts) != 4:
                    continue
                _prefix, anchor, tier, fname = parts
                if anchor not in anchors:
                    continue
                if tiers is not None and tier not in tiers:
                    continue
                period = fname.removesuffix('.parquet')
                out.append({
                    'variant': v,
                    'anchor': anchor,
                    'tier': tier,
                    'period': period,
                    'key': key,
                    'bytes': int(o['Size']),
                })
    return out


def _stats_for_shard(
    variant: Variant, anchor: Anchor, tier: str, period: str, key: str, bytes_: int,
) -> list[dict]:
    """Read shard from R2, return per-level stats rows.

    Constructs its own R2 client — ProcessPool-safe (no client pickling).
    """
    cc = rides_cell_col(anchor, variant)
    cli = r2_client()
    obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    buf = io.BytesIO(obj['Body'].read())
    df = pd.read_parquet(buf, columns=[cc, 'dt', *DIM_COLS])
    if variant == 'v3':
        df['level'] = [s2cell.token_to_level(c) for c in df[cc].values]
    else:
        df['level'] = [h3.get_resolution(c) for c in df[cc].values]
    rows = []
    for level, sub in df.groupby('level', sort=True):
        dim_combos = sub[DIM_COLS].drop_duplicates().shape[0]
        rows.append({
            'variant': variant,
            'anchor': anchor,
            'tier': tier,
            'level': int(level),
            'shard': period,
            'bytes': bytes_,        # whole-shard parquet bytes (all levels)
            'rows': int(len(sub)),
            'distinct_cells': int(sub[cc].nunique()),
            'distinct_dts': int(sub['dt'].nunique()),
            'distinct_dim_combos': int(dim_combos),
        })
    return rows


def _stats_task(args: tuple) -> list[dict]:
    """ProcessPool entry point — unpack args and invoke `_stats_for_shard`."""
    variant, anchor, tier, period, key, bytes_ = args
    return _stats_for_shard(variant, anchor, tier, period, key, bytes_)


@ctbk.command('pyramid-stats', help="Inventory + per-(variant,anchor,tier,level,shard) stats for R2 rides pyramids.")
@option('-a', '--anchor', type=str, default='both', help="'start' | 'end' | 'both' (default 'both').")
@option('-c', '--concurrency', type=int, default=8, help="ProcessPool workers (default 8).")
@option('-o', '--output', 'output', type=str, required=True, help="JSONL output path.")
@option('-r', '--resume', is_flag=True,
        help="If output exists, skip shards already represented in it (append).")
@option('-t', '--tiers', 'tiers', type=str, default=None,
        help="Comma-separated tier list; default = all discovered.")
@option('-v', '--variants', 'variants_csv', type=str, default='v1,v2,v3',
        help="Comma-separated variants (default v1,v2,v3).")
def pyramid_stats_cmd(
    anchor: str,
    concurrency: int,
    output: str,
    resume: bool,
    tiers: str | None,
    variants_csv: str,
):
    variants = tuple(v.strip() for v in variants_csv.split(','))
    for v in variants:
        if v not in VARIANTS:
            raise BadParameter(f"unknown variant {v!r}; known: {list(VARIANTS)}")
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]
    tier_tup = tuple(t.strip() for t in tiers.split(',')) if tiers else None

    cli = r2_client()
    shards = list_shards(cli, variants, anchors, tier_tup)  # type: ignore[arg-type]
    by_variant = ', '.join(f"{v}: {sum(1 for s in shards if s['variant'] == v)}" for v in variants)
    err(f"pyramid-stats: discovered {len(shards):,} shards ({by_variant})")

    out_path = Path(output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    done_keys: set[tuple[str, str, str, str]] = set()
    if resume and out_path.exists():
        with out_path.open() as rf:
            for line in rf:
                d = json.loads(line)
                done_keys.add((d['variant'], d['anchor'], d['tier'], d['shard']))
        before = len(shards)
        shards = [s for s in shards if (s['variant'], s['anchor'], s['tier'], s['period']) not in done_keys]
        err(f"  resume: skipping {before - len(shards):,} shards already done, "
            f"processing {len(shards):,} remaining")

    mode = 'a' if resume else 'w'
    n_done = 0
    args_iter = [(s['variant'], s['anchor'], s['tier'], s['period'], s['key'], s['bytes'])
                 for s in shards]
    with out_path.open(mode) as f, ProcessPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(_stats_task, a): a for a in args_iter}
        for fut in as_completed(futs):
            rows = fut.result()
            for r in rows:
                f.write(json.dumps(r) + '\n')
            f.flush()
            n_done += 1
            if n_done % 25 == 0 or n_done == len(shards):
                err(f"  {n_done:,} / {len(shards):,}")

    err(f"pyramid-stats: wrote {out_path}")


# ─── D1 (SQLite) size probe ────────────────────────────────────────────

# Spec dim encoding: gender 0/1/2 already matches Citibike raw, but our parquet
# stores strings — map them back to integers. user_type / bike_type encoded by
# dense observed-value order (deterministic per shard).
GENDER_TO_INT = {'unknown': 0, 'male': 1, 'female': 2}


def _build_sqlite(
    df: pd.DataFrame,
    cell_col_name: str,
    db_path: Path,
    table: str,
) -> tuple[int, int]:
    """Create the spec-schema SQLite table, INT-encode dim cols, INSERT rows, VACUUM.

    Returns `(rows_inserted, file_bytes_after_vacuum)`.
    """
    if db_path.exists():
        db_path.unlink()

    user_types = sorted(df['user_type'].dropna().unique().tolist())
    bike_types = sorted(df['bike_type'].dropna().unique().tolist())
    user_type_to_int = {v: i for i, v in enumerate(user_types)}
    bike_type_to_int = {v: i for i, v in enumerate(bike_types)}

    enc = pd.DataFrame({
        'dt': df['dt'].astype('int64').values,
        'cell': df[cell_col_name].astype(str).values,
        'gender': df['gender'].map(GENDER_TO_INT).fillna(0).astype('int64').values,
        'user_type': df['user_type'].map(user_type_to_int).fillna(0).astype('int64').values,
        'bike_type': df['bike_type'].map(bike_type_to_int).fillna(0).astype('int64').values,
        'count_n': df['count_n'].astype('int64').values,
        'count_sum': df['count_sum'].astype('int64').values,
        'count_sumsq': df['count_sumsq'].astype('int64').values,
        'duration_n': df['duration_n'].astype('int64').values,
        'duration_sum': df['duration_sum'].astype('int64').values,
        'duration_sumsq': df['duration_sumsq'].astype('int64').values,
    })

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=OFF")
        cur.execute("PRAGMA synchronous=OFF")
        cur.execute("PRAGMA page_size=4096")
        cur.execute(f"""
            CREATE TABLE {table} (
              dt             INTEGER NOT NULL,
              cell           TEXT    NOT NULL,
              gender         INTEGER NOT NULL,
              user_type      INTEGER NOT NULL,
              bike_type      INTEGER NOT NULL,
              count_n        INTEGER NOT NULL,
              count_sum      INTEGER NOT NULL,
              count_sumsq    INTEGER NOT NULL,
              duration_n     INTEGER NOT NULL,
              duration_sum   INTEGER NOT NULL,
              duration_sumsq INTEGER NOT NULL,
              PRIMARY KEY (cell, dt, gender, user_type, bike_type)
            ) WITHOUT ROWID
        """)
        # Bulk insert
        cols = ['dt', 'cell', 'gender', 'user_type', 'bike_type',
                'count_n', 'count_sum', 'count_sumsq',
                'duration_n', 'duration_sum', 'duration_sumsq']
        placeholders = ','.join(['?'] * len(cols))
        recs = list(map(tuple, enc[cols].itertuples(index=False, name=None)))
        cur.executemany(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})", recs)
        # Secondary index on (dt) as per spec
        cur.execute(f"CREATE INDEX {table}_dt ON {table} (dt)")
        conn.commit()
        cur.execute("VACUUM")
        conn.commit()
    finally:
        conn.close()

    return len(enc), int(db_path.stat().st_size)


def _probe_one_shard(
    cli,
    variant: Variant,
    anchor: Anchor,
    tier: str,
    period: str,
    key: str,
    bytes_: int,
    workdir: Path,
) -> dict:
    cc = rides_cell_col(anchor, variant)
    obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    buf = io.BytesIO(obj['Body'].read())
    df = pd.read_parquet(buf)
    table = f"rides_{anchor}_{tier.replace('-', '_')}"
    db_path = workdir / f'{variant}_{anchor}_{tier}_{period}.sqlite'
    rows, db_bytes = _build_sqlite(df, cc, db_path, table)
    return {
        'variant': variant,
        'anchor': anchor,
        'tier': tier,
        'shard': period,
        'parquet_bytes': int(bytes_),
        'sqlite_bytes': int(db_bytes),
        'ratio': round(db_bytes / max(bytes_, 1), 4),
        'rows': int(rows),
        'db_path': str(db_path),
    }


@ctbk.command('d1-size-probe', help="Measure parquet→SQLite size for representative tiers.")
@option('-a', '--anchor', type=str, default='both', help="'start' | 'end' | 'both' (default 'both').")
@option('-K', '--keep', is_flag=True, help="Keep the SQLite files after probing.")
@option('-o', '--output', 'output', type=str, required=True, help="JSONL output path.")
@option('-p', '--per-tier', is_flag=True,
        help="Probe only the largest shard per (variant, anchor, tier) — for fast extrapolation.")
@option('-t', '--tiers', 'tiers', type=str, default='1mo,3mo,1y',
        help="Comma-separated tiers (default: 1mo,3mo,1y).")
@option('-v', '--variants', 'variants_csv', type=str, default='v3',
        help="Comma-separated variants (default v3).")
@option('-w', '--workdir', type=str, default='tmp/d1-probe',
        help="Workdir for SQLite files (default tmp/d1-probe).")
def d1_size_probe_cmd(
    anchor: str,
    keep: bool,
    output: str,
    per_tier: bool,
    tiers: str,
    variants_csv: str,
    workdir: str,
):
    variants = tuple(v.strip() for v in variants_csv.split(','))
    for v in variants:
        if v not in VARIANTS:
            raise BadParameter(f"unknown variant {v!r}; known: {list(VARIANTS)}")
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]
    tier_tup = tuple(t.strip() for t in tiers.split(','))

    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)

    cli = r2_client()
    shards = list_shards(cli, variants, anchors, tier_tup)  # type: ignore[arg-type]

    if per_tier:
        # Keep the largest shard per (variant, anchor, tier).
        by_key: dict[tuple[str, str, str], dict] = {}
        for s in shards:
            k = (s['variant'], s['anchor'], s['tier'])
            if k not in by_key or s['bytes'] > by_key[k]['bytes']:
                by_key[k] = s
        shards = sorted(by_key.values(), key=lambda s: (s['variant'], s['anchor'], s['tier']))

    combos = sorted({f"{s['variant']}/{s['anchor']}/{s['tier']}" for s in shards})
    err(f"d1-size-probe: {len(shards)} shards ({', '.join(combos)})")

    out_path = Path(output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    with out_path.open('w') as f:
        for s in shards:
            err(f"  probing {s['variant']}/{s['anchor']}/{s['tier']}/{s['period']} "
                f"({s['bytes']:,} B parquet)")
            r = _probe_one_shard(
                cli, s['variant'], s['anchor'], s['tier'], s['period'], s['key'], s['bytes'], work,
            )
            err(f"    → {r['rows']:,} rows, {r['sqlite_bytes']:,} B SQLite "
                f"(ratio {r['ratio']:.2f}×)")
            f.write(json.dumps(r) + '\n')
            f.flush()
            results.append(r)
            if not keep:
                Path(r['db_path']).unlink(missing_ok=True)

    err(f"d1-size-probe: wrote {out_path} ({len(results)} entries)")
