"""D1 access — thin wrapper over `pyrmts.d1` (moved upstream,
ops-adoption phase 1: pyrmts `specs/pyrmts-ops-adoption.md`). ctbk
residue kept here: the `ctbk-gbfs` database-id default and the
per-registration stderr log line (the library stays silent).

Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (D1 edit scope),
optional `D1_DATABASE_ID` (defaults to the `ctbk-gbfs` database).
"""
from __future__ import annotations

import os

from pyrmts.d1 import d1_query as _d1_query, register_shard as _register_shard
from utz import err

# `ctbk-gbfs` (gbfs/api wrangler.toml `DB` binding).
DEFAULT_DATABASE_ID = 'd5746734-70ba-46aa-8780-be09e4837f0b'


def _db(database_id: str | None) -> str:
    return database_id or os.environ.get('D1_DATABASE_ID', DEFAULT_DATABASE_ID)


def d1_query(
    sql: str,
    params: list | None = None,
    *,
    database_id: str | None = None,
) -> list[dict]:
    """Run one statement; return its result rows. Raises on any error
    (HTTP or D1-level) — callers treat registration as must-succeed."""
    return _d1_query(sql, params, database_id=_db(database_id))


def register_shard(
    *,
    pyramid: str,
    tier: str,
    shard_dur: str,
    period_start_ms: int,
    period_end_ms: int,
    key: str,
    written_at_ms: int,
) -> None:
    """INSERT OR REPLACE one row into `pyramid_shards` — same shape the
    CFW cascade and `emit_d1_insert_sql` write."""
    _register_shard(
        pyramid=pyramid,
        tier=tier,
        shard_dur=shard_dur,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        key=key,
        written_at_ms=written_at_ms,
        database_id=_db(None),
    )
    err(f'  d1: registered {key}')
