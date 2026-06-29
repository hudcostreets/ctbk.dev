"""`ctbk avail-v3-heartbeat`: check the avail-v3 cascade CFW is alive.

Currently checks (scope = what the CFW today auto-maintains; expand as
Phases 3+4 of `specs/avail-v3-steady-state.md` land):

  1. /1m canonical for the most recent expected day exists.
     "Most recent expected" = `floor((now - grace) / 1d) - 1d`, i.e. the
     day that closed at the last midnight tick. `--grace` (default 30
     min) absorbs the cascade's tick lag.

  2. /1m partials are FRESH: for each cadence in the ladder, the
     just-closed period's partial exists within `--lag-multiplier`
     (default 2) cadence-lengths of now. E.g., at multiplier=2:
     /p5min must be within 10min, /p3h within 6h, /p12h within 24h.

Exits non-zero with a per-check report on stderr when any check fails.
Intended for GHA cron `0 */6 * * *` → failure = email notification.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Iterable

from click import option
from utz import err

from ctbk.cli.base import ctbk
from ctbk.pyramid_cascade.storage import storage_from_cfg


# Mirrors `gbfs/cascade/src/avail3/cascade.ts#CADENCES` (label, minutes).
CFW_CADENCES: list[tuple[str, int]] = [
    ('5min',  5),
    ('10min', 10),
    ('30min', 30),
    ('1h',    60),
    ('3h',    180),
    ('12h',   720),
]
CANONICAL_1M_KEY_FMT = 'avail-v3/1m/{date}.parquet'
PARTIAL_1M_KEY_FMT   = 'avail-v3/1m/p{cad}/{period}.parquet'


def _format_period(period_start: datetime, cadence_min: int) -> str:
    """Per `formatPeriod` in `cascade.ts`: minute-precision for sub-hour
    cadences, hour-precision for sub-day, date for ≥1d."""
    iso = period_start.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    if cadence_min < 60:
        return iso[:16].replace(':', '-')  # 2026-06-29T03-35
    if cadence_min < 60 * 24:
        return iso[:13]                    # 2026-06-29T03
    return iso[:10]                        # 2026-06-29


def _floor_to(t: datetime, span_min: int) -> datetime:
    """Floor `t` to the previous `span_min` boundary (epoch-aligned)."""
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta_min = (t - epoch).total_seconds() / 60
    floored_min = int(delta_min // span_min) * span_min
    return epoch + timedelta(minutes=floored_min)


def _check_canonical_1m(storage, now: datetime, grace_min: int) -> tuple[bool, str]:
    """Yesterday's /1m canonical exists. `grace_min` absorbs the
    cascade's midnight-tick lag (in practice <1min, but the check fires
    every 6h so being generous is cheap)."""
    expected_day_start = _floor_to(now - timedelta(minutes=grace_min), 24 * 60) - timedelta(days=1)
    date_str = expected_day_start.strftime('%Y-%m-%d')
    key = CANONICAL_1M_KEY_FMT.format(date=date_str)
    meta = storage.head(key)
    if meta is None:
        return False, f"MISS  /1m@{date_str}.parquet (expected after midnight tick {expected_day_start + timedelta(days=1):%Y-%m-%dT%H:%MZ})"
    return True, f"OK    /1m@{date_str}.parquet ({meta['size']:,}B)"


def _check_partial_freshness(
    storage,
    now: datetime,
    cad_label: str,
    cad_min: int,
    max_lag_min: int,
) -> tuple[bool, str]:
    """Check a /1m@p<cad> partial exists for the most-recent boundary
    within `max_lag_min` of `now`. Walks backwards in `cad_min` steps
    until found or lag budget exhausted."""
    # The most recent cadence boundary at-or-before `now` — period it
    # represents covers `[boundary - cad_min, boundary)`. The CFW writes
    # the file with `periodStart = boundary - cad_min`.
    nominal_boundary = _floor_to(now, cad_min)
    lag_budget = max_lag_min
    boundary = nominal_boundary
    while True:
        period_start = boundary - timedelta(minutes=cad_min)
        period_label = _format_period(period_start, cad_min)
        key = PARTIAL_1M_KEY_FMT.format(cad=cad_label, period=period_label)
        meta = storage.head(key)
        if meta is not None:
            actual_lag = (now - boundary).total_seconds() / 60
            return True, f"OK    /1m@p{cad_label} latest={period_label} (lag={actual_lag:.0f}min, {meta['size']:,}B)"
        boundary -= timedelta(minutes=cad_min)
        lag_budget = (now - boundary).total_seconds() / 60
        if lag_budget > max_lag_min:
            return False, (
                f"MISS  /1m@p{cad_label} no partial within {max_lag_min}min of {now:%Y-%m-%dT%H:%MZ} "
                f"(searched back to period_start={period_start.isoformat()})"
            )


@ctbk.command(
    'avail-v3-heartbeat',
    help="Check the avail-v3 cascade CFW is producing /1m canonical + partials on schedule.",
)
@option('-c', '--cadences', default=','.join(c[0] for c in CFW_CADENCES), help="Comma-separated cadence labels to check freshness for (subset of CFW ladder).")
@option('-g', '--grace', 'grace_min', type=int, default=30, help="Minutes of slack for yesterday's /1m canonical (absorbs midnight-tick lag).")
@option('-l', '--lag-multiplier', 'lag_mult', type=int, default=2, help="Per-cadence max lag = `lag_multiplier * cadence_min`. Default 2 = tolerates 1 missed boundary.")
@option('-n', '--now', 'now_iso', default=None, help="Override 'now' (UTC ISO 8601, for testing).")
def avail_v3_heartbeat_cmd(
    cadences: str,
    grace_min: int,
    lag_mult: int,
    now_iso: str | None,
):
    if now_iso:
        now = datetime.fromisoformat(now_iso).replace(tzinfo=timezone.utc)
    else:
        now = datetime.now(timezone.utc)

    storage = storage_from_cfg({
        'type': 's3', 'bucket': 'ctbk',
        'key': 'avail-v3/{tier}/{period}.parquet',
    })

    err(f"avail-v3-heartbeat @ {now:%Y-%m-%dT%H:%M:%SZ}  (lag-multiplier={lag_mult})")

    requested = set(cadences.split(','))
    checks: list[tuple[bool, str]] = []

    # Check 1: yesterday's /1m canonical.
    checks.append(_check_canonical_1m(storage, now, grace_min))

    # Check 2: freshness for each requested cadence.
    for label, minutes in CFW_CADENCES:
        if label not in requested:
            continue
        max_lag_min = minutes * lag_mult
        checks.append(_check_partial_freshness(storage, now, label, minutes, max_lag_min))

    for ok, msg in checks:
        err(f"  {msg}")

    n_miss = sum(1 for ok, _ in checks if not ok)
    if n_miss:
        err(f"\nHEARTBEAT FAIL: {n_miss}/{len(checks)} checks missed")
        raise SystemExit(1)
    err(f"\nheartbeat ok: {len(checks)}/{len(checks)} checks passed")
