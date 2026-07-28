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


def _proxy() -> tuple[str, str] | None:
    """(url, secret) of the worker registry proxy, when configured.
    The proxy writes via the worker's D1 *binding* — the workaround for
    the 2026-07-28 D1 REST split-brain (Lambda-originated REST writes
    landing in a divergent copy; the binding stayed truthful)."""
    url = os.environ.get('CTBK_REGISTRY_URL')
    secret = os.environ.get('CTBK_REGISTRY_SECRET')
    return (url, secret) if url and secret else None


def _proxy_post(body: dict) -> dict:
    import json as _json
    import urllib.request
    url, secret = _proxy()  # type: ignore[misc]
    req = urllib.request.Request(
        f'{url}/api/registry', data=_json.dumps(body).encode(),
        headers={
            'Authorization': f'Bearer {secret}',
            'Content-Type': 'application/json',
            # CF bot-filtering 403s default urllib UAs (same lesson as the
            # parity harness).
            'User-Agent': 'ctbk-cascade-lambda/1.0',
        })
    with urllib.request.urlopen(req, timeout=60) as resp:
        import json as _j
        return _j.loads(resp.read())


def registered_keys(pyramid: str) -> set[str]:
    """All registered keys for `pyramid` — via the proxy when configured
    (consistent binding view), else D1 REST."""
    if _proxy():
        return set(_proxy_post({'op': 'existing_keys', 'pyramid': pyramid})['keys'])
    return {r['key'] for r in d1_query('SELECT key FROM pyramid_shards WHERE pyramid = ?', [pyramid])}


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
    CFW cascade and `emit_d1_insert_sql` write. Routed via the worker
    registry proxy when configured (see `_proxy`)."""
    if _proxy():
        _proxy_post({'op': 'register', 'rows': [{
            'pyramid': pyramid, 'tier': tier, 'shard_dur': shard_dur,
            'period_start': period_start_ms, 'period_end': period_end_ms,
            'key': key, 'written_at': written_at_ms,
        }]})
    else:
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
    err(f'  d1: registered {key} via {"proxy" if _proxy() else "rest"}')
