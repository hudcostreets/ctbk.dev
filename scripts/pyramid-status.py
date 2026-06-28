#!/usr/bin/env -S uv run --quiet --no-config --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click"]
# ///
"""Snapshot pyrmts D1 state for a pyramid: watermarks + per-(tier, cadence)
earliest + latest. Avoids re-typing `wrangler d1 execute ... | python -c ...`
incantations every time. Shells out to `wrangler` so it works from any
project root.
"""
from __future__ import annotations
import json
import subprocess
import sys
from datetime import datetime, timezone
from functools import partial

import click
from click import argument, option

err = partial(print, file=sys.stderr)


def d1(db: str, sql: str) -> list[dict]:
    """Run a SELECT against the remote D1 binding; return rows as dicts."""
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", db, "--remote", "--command", sql, "--json"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(res.stdout)[0]["results"]


def ms_to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


@click.command()
@option('-d', '--db', default='ctbk-gbfs', help='D1 database binding name')
@option('-i', '--interval', type=int, default=0, help='If >0, poll every N seconds until ctrl-C')
@option('-t', '--tier', default=None, help='Filter to a single tier (e.g. `1m`)')
@argument('pyramid')
def main(db: str, interval: int, tier: str | None, pyramid: str):
    """Print pyrmts watermarks + per-(tier, cadence) earliest.

    Example:
      pyramid-status.py avail
      pyramid-status.py -t 1m avail
      pyramid-status.py -i 30 avail   # poll every 30s
    """
    while True:
        tier_filter = f" AND tier = '{tier}'" if tier else ""
        wm = d1(db, (
            f"SELECT tier, cadence, latest_period_end, updated_at "
            f"FROM pyramid_watermarks WHERE pyramid = '{pyramid}'{tier_filter} "
            f"ORDER BY tier, cadence"
        ))
        earliest = d1(db, (
            f"SELECT tier, cadence, MIN(period_start) AS earliest, MAX(period_end) AS latest, COUNT(*) AS n "
            f"FROM pyramid_shards WHERE pyramid = '{pyramid}'{tier_filter} "
            f"GROUP BY tier, cadence ORDER BY tier, cadence"
        ))
        earliest_by_key = {(r["tier"], r["cadence"]): r for r in earliest}

        print(f"\n=== pyramid={pyramid} @ {datetime.now(timezone.utc):%H:%M:%S}Z ===")
        print(f"  {'tier':<5} {'cadence':<8} {'watermark_end':<22} {'earliest_shard':<22} {'latest_shard':<22} {'n':>4}")
        for w in wm:
            t, c = w["tier"], w["cadence"]
            inv = earliest_by_key.get((t, c), {})
            c_label = c if c else "(canon)"
            print(
                f"  {t:<5} {c_label:<8} "
                f"{ms_to_iso(w['latest_period_end']):<22} "
                f"{ms_to_iso(inv['earliest']) if inv.get('earliest') else '-':<22} "
                f"{ms_to_iso(inv['latest']) if inv.get('latest') else '-':<22} "
                f"{inv.get('n', 0):>4}"
            )
        if interval <= 0:
            break
        import time
        time.sleep(interval)


if __name__ == '__main__':
    main()
