"""Build a SQLite database for Cloudflare D1 from rides-v* parquet shards.

For each (variant, anchor, tier) in a "tier-group" (default: COARSE = 1d-1y
for v3 both anchors), fetch all R2 shards, materialize into one table in a
single SQLite file matching the pyrmts-d1-backend spec schema:

    CREATE TABLE rides_{anchor}_{tier} (
      dt INTEGER NOT NULL,
      cell TEXT NOT NULL,
      gender INTEGER NOT NULL,        -- 0=unknown, 1=male, 2=female
      user_type INTEGER NOT NULL,     -- 0=Customer, 1=Subscriber, 2=nan
      bike_type INTEGER NOT NULL,     -- 0=unknown, 1=classic_bike, 2=electric_bike
      count_n INTEGER NOT NULL,
      count_sum INTEGER NOT NULL,
      count_sumsq INTEGER NOT NULL,
      duration_n INTEGER NOT NULL,
      duration_sum INTEGER NOT NULL,
      duration_sumsq INTEGER NOT NULL,
      PRIMARY KEY (cell, dt, gender, user_type, bike_type)
    ) WITHOUT ROWID;
    CREATE INDEX rides_{anchor}_{tier}_dt ON rides_{anchor}_{tier} (dt);

Dim columns are INT-encoded (matching Phase 0 d1-size-probe) — TEXT dims
in the same schema produced a 12 GB file vs the 6.6 GB INT measurement,
because the dt secondary index also stores the PK columns. The encoding
maps are emitted as `<output>.dim-maps.json` for the worker to decode
back to strings (matching the parquet schema row shape downstream).

Output: a single `.sqlite` file. Caller pushes to D1 via `wrangler d1
import <DB> --file=db.sqlite`.
"""
from __future__ import annotations

import io
import json
import sqlite3
from pathlib import Path
from typing import Literal

import pandas as pd
from click import BadParameter, option
from utz import err
from utz.cli import flag

from ctbk.cli.base import ctbk
from ctbk.rides_v1 import (
    ANCHORS, Anchor, R2_BUCKET, VARIANTS, Variant,
    cell_col as rides_cell_col, r2_client,
)
from ctbk.d1_sizing import list_shards


# Canonical dim encoding. The values are all the distinct strings
# observed across the v3 corpus (queried 2026-06-07 against
# `tmp/d1/v3-coarse.sqlite`); INTs assigned for deterministic packing
# (alphabetical with `unknown`/`nan` adjusted to preserve the Citibike
# Gender encoding 0/1/2).
GENDER_INT: dict[str, int] = {'unknown': 0, 'male': 1, 'female': 2}
USER_TYPE_INT: dict[str, int] = {'Customer': 0, 'Subscriber': 1, 'nan': 2}
BIKE_TYPE_INT: dict[str, int] = {'unknown': 0, 'classic_bike': 1, 'electric_bike': 2}

# Inverse maps for the JSON sidecar (worker decodes int → string).
DIM_MAPS: dict[str, dict[int, str]] = {
    'gender': {v: k for k, v in GENDER_INT.items()},
    'user_type': {v: k for k, v in USER_TYPE_INT.items()},
    'bike_type': {v: k for k, v in BIKE_TYPE_INT.items()},
}


# Pre-defined tier groups for D1 packing. Each maps a logical "bundle" name
# to the (anchor, tier) tables it holds. See `specs/pyrmts-d1-backend.md`
# §"Verdict" for sizing rationale.
TIER_GROUPS: dict[str, tuple[str, ...]] = {
    # Conservative starter — unblocks load-bearing monthly chart in one DB.
    'coarse': ('1d', '3d', '7d', '14d', '1mo', '3mo', '1y'),
    # Extended — adds 12h. Still fits one D1 for both anchors (~13 GB? tight).
    'coarse-12h': ('12h', '1d', '3d', '7d', '14d', '1mo', '3mo', '1y'),
    # Mid — 3h, 6h. Sized per anchor (each fits 10 GB).
    'mid': ('3h', '6h'),
    # All — for testing only; will not fit one D1.
    'all': ('1h', '3h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo', '3mo', '1y'),
}


def table_name(anchor: Anchor, tier: str) -> str:
    """Normalize tier name for SQL (replace any non-ident chars)."""
    safe_tier = tier.replace('-', '_')
    return f'rides_{anchor}_{safe_tier}'


def create_table(conn: sqlite3.Connection, table: str) -> None:
    cur = conn.cursor()
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS {table} (
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
    cur.execute(f"CREATE INDEX IF NOT EXISTS {table}_dt ON {table} (dt)")
    conn.commit()


def load_shard_to_table(
    conn: sqlite3.Connection,
    cli,
    table: str,
    cell_col_name: str,
    key: str,
) -> int:
    """Fetch one parquet shard from R2 and INSERT into the table.

    Returns rows inserted.
    """
    obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    buf = io.BytesIO(obj['Body'].read())
    df = pd.read_parquet(buf)
    # Rename the cell column to canonical 'cell' (parquet has start_s2_cell etc).
    df = df.rename(columns={cell_col_name: 'cell'})
    cols = ['dt', 'cell', 'gender', 'user_type', 'bike_type',
            'count_n', 'count_sum', 'count_sumsq',
            'duration_n', 'duration_sum', 'duration_sumsq']
    df = df[cols]
    # INT-encode dim columns (per the spec schema).
    g = df['gender'].astype(str).map(GENDER_INT)
    u = df['user_type'].astype(str).map(USER_TYPE_INT)
    b = df['bike_type'].astype(str).map(BIKE_TYPE_INT)
    bad_mask = g.isna() | u.isna() | b.isna()
    if bad_mask.any():
        bad = df.loc[bad_mask, ['gender', 'user_type', 'bike_type']]
        raise RuntimeError(
            f"unmapped dim value(s) in {key}: "
            f"gender={set(bad['gender'].unique())} "
            f"user_type={set(bad['user_type'].unique())} "
            f"bike_type={set(bad['bike_type'].unique())}"
        )
    df['gender']    = g.astype('int64')
    df['user_type'] = u.astype('int64')
    df['bike_type'] = b.astype('int64')
    for c in ('dt', 'count_n', 'count_sum', 'count_sumsq',
              'duration_n', 'duration_sum', 'duration_sumsq'):
        df[c] = df[c].astype('int64')
    df['cell'] = df['cell'].astype(str)

    recs = list(map(tuple, df.itertuples(index=False, name=None)))
    placeholders = ','.join(['?'] * len(cols))
    cur = conn.cursor()
    cur.executemany(
        f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({placeholders})",
        recs,
    )
    conn.commit()
    return len(recs)


@ctbk.command('rides-d1-build', help="Build a SQLite file for D1 from rides-v* R2 shards.")
@option('-a', '--anchor', type=str, default='both', help="'start' | 'end' | 'both' (default 'both').")
@option('-G', '--tier-group', type=str, default='coarse',
        help=f"Tier-group name (default: 'coarse'). Known: {list(TIER_GROUPS)}.")
@option('-o', '--output', 'output', type=str, required=True,
        help="Output SQLite file path.")
@option('-O', '--overwrite', is_flag=True, help="Delete output file before building.")
@option('-v', '--variant', type=str, default='v3', help="Variant (default 'v3').")
@option('-V', '--no-vacuum', 'no_vacuum', is_flag=True, help="Skip VACUUM at end.")
def rides_d1_build_cmd(
    anchor: str,
    tier_group: str,
    output: str,
    overwrite: bool,
    variant: str,
    no_vacuum: bool,
):
    if variant not in VARIANTS:
        raise BadParameter(f"unknown --variant {variant!r}; known: {list(VARIANTS)}")
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    if tier_group not in TIER_GROUPS:
        raise BadParameter(f"unknown --tier-group {tier_group!r}; known: {list(TIER_GROUPS)}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]
    tiers = TIER_GROUPS[tier_group]

    out_path = Path(output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        if not overwrite:
            raise BadParameter(f"{out_path} exists (use --overwrite to replace)")
        out_path.unlink()

    cli = r2_client()
    shards = list_shards(cli, (variant,), anchors, tiers)  # type: ignore[arg-type]
    by_table: dict[tuple[str, str], list[dict]] = {}
    for s in shards:
        by_table.setdefault((s['anchor'], s['tier']), []).append(s)
    err(f"rides-d1-build: variant={variant} anchors={anchors} tiers={tiers} "
        f"→ {len(by_table)} tables, {len(shards)} total shards → {out_path}")

    conn = sqlite3.connect(str(out_path))
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=OFF")
        cur.execute("PRAGMA synchronous=OFF")
        cur.execute("PRAGMA page_size=4096")
        cur.execute("PRAGMA temp_store=MEMORY")

        for (a, t), tshards in sorted(by_table.items()):
            tbl = table_name(a, t)  # type: ignore[arg-type]
            create_table(conn, tbl)
            cc = rides_cell_col(a, variant)  # type: ignore[arg-type]
            n_rows = 0
            for s in sorted(tshards, key=lambda s: s['period']):
                n = load_shard_to_table(conn, cli, tbl, cc, s['key'])
                n_rows += n
                err(f"  {tbl}/{s['period']}: +{n:,} rows")
            err(f"  {tbl} TOTAL: {n_rows:,} rows ({len(tshards)} shards)")

        if not no_vacuum:
            err("VACUUM ...")
            conn.commit()
            cur.execute("VACUUM")
            conn.commit()
    finally:
        conn.close()

    size = out_path.stat().st_size
    err(f"rides-d1-build: wrote {out_path} ({size:,} B = {size/1e9:.2f} GB)")

    # Sidecar: dim INT→string maps for the worker to decode rows from this DB.
    sidecar = out_path.with_suffix(out_path.suffix + '.dim-maps.json')
    with sidecar.open('w') as f:
        json.dump(DIM_MAPS, f, indent=2)
    err(f"rides-d1-build: wrote {sidecar} (dim INT→string maps)")
