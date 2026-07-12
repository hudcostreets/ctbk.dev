"""D1 access over Cloudflare's REST API.

The Python cascade paths historically emitted a SQL file for
`wrangler d1 execute` (see `materialize.emit_d1_insert_sql`) — fine for
interactive backfills, unusable in a Lambda. This module talks to
`POST /client/v4/accounts/{acct}/d1/database/{db}/query` directly.

Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (D1 edit scope),
optional `D1_DATABASE_ID` (defaults to the `ctbk-gbfs` database).
"""
from __future__ import annotations

import json
import os
import urllib.request
from urllib.error import HTTPError

from utz import err

# `ctbk-gbfs` (gbfs/api wrangler.toml `DB` binding).
DEFAULT_DATABASE_ID = 'd5746734-70ba-46aa-8780-be09e4837f0b'


def d1_query(
    sql: str,
    params: list | None = None,
    *,
    database_id: str | None = None,
) -> list[dict]:
    """Run one statement; return its result rows. Raises on any error
    (HTTP or D1-level) — callers treat registration as must-succeed."""
    acct = os.environ['CLOUDFLARE_ACCOUNT_ID']
    token = os.environ['CLOUDFLARE_API_TOKEN']
    db = database_id or os.environ.get('D1_DATABASE_ID', DEFAULT_DATABASE_ID)
    url = f'https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query'
    body = json.dumps({'sql': sql, 'params': params or []}).encode()
    req = urllib.request.Request(url, data=body, headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except HTTPError as e:
        raise RuntimeError(f'D1 HTTP {e.code}: {e.read().decode(errors="replace")[:300]}') from e
    if not payload.get('success'):
        raise RuntimeError(f'D1 query failed: {json.dumps(payload.get("errors"))[:300]}')
    results = payload['result']
    return results[0].get('results', []) if results else []


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
    d1_query(
        'INSERT OR REPLACE INTO pyramid_shards '
        '(pyramid, tier, shard_dur, period_start, period_end, key, written_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [pyramid, tier, shard_dur, period_start_ms, period_end_ms, key, written_at_ms],
    )
    err(f'  d1: registered {key}')
