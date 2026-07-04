#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "utz", "pyrmts", "boto3"]
# ///
"""One-off: emit `pyramid_shards` + `pyramid_watermarks` INSERT SQL for
every avail-v3 R2 key currently present. Idempotent (ON CONFLICT DO
UPDATE) — safe to apply over an already-populated D1.

Motivating incident: a killed `pyramid-cascade --fsck --fill` wrote 37
shards to R2, then its `tmp/fsck-d1-record.sql` was overwritten by the
next fill run (which only saw 7 gaps). This script re-derives the D1
registrations directly from R2 state.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from click import option
from pyrmts.axis import add_span, parse_duration
from utz import err
from utz.cli import cmd

from ctbk.avail_v3 import R2_BUCKET, r2_client


def _parse_period_label(label: str, shard_dur: str) -> datetime:
    """Inverse of pyrmts.axis.format_period. Interprets `label` per the
    shard_dur's unit-formatting rule."""
    span = parse_duration(shard_dur)
    unit = span.unit
    if unit == 'y':
        return datetime(int(label), 1, 1, tzinfo=timezone.utc)
    if unit == 'mo':
        y, m = label.split('-')
        return datetime(int(y), int(m), 1, tzinfo=timezone.utc)
    if unit == 'd':
        return datetime.strptime(label, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    if unit == 'h':
        return datetime.strptime(label, '%Y-%m-%dT%H').replace(tzinfo=timezone.utc)
    if unit == 'min':
        return datetime.strptime(label, '%Y-%m-%dT%H-%M').replace(tzinfo=timezone.utc)
    raise AssertionError(f"unreachable: {unit}")


@cmd
@option('-o', '--out', 'out_path', default='tmp/reregister-avail-v3.sql', help="Output SQL path")
@option('-p', '--pyramid-name', default='avail', help="D1 pyramid column value")
@option('-r', '--r2-prefix', default='avail-v3/', help="R2 prefix to scan")
def main(out_path: str, pyramid_name: str, r2_prefix: str) -> None:
    cli = r2_client()
    keys: list[str] = []
    kwargs = {'Bucket': R2_BUCKET, 'Prefix': r2_prefix, 'MaxKeys': 1000}
    while True:
        resp = cli.list_objects_v2(**kwargs)
        keys.extend(k['Key'] for k in resp.get('Contents', []))
        if not resp.get('IsTruncated'):
            break
        kwargs['ContinuationToken'] = resp['NextContinuationToken']
    err(f"listed {len(keys)} R2 keys under {r2_prefix}")

    lines: list[str] = []
    watermarks: dict[tuple[str, str], int] = {}  # (tier, shard) → max period_end_ms
    skipped_legacy = 0
    for key in keys:
        # avail-v3/<tier>/<shard_dur>/<period_label>.parquet — post-cutover.
        # Legacy `avail-v3/<tier>/<period>.parquet` (pre-unified-ladder)
        # coexists on R2 until the laptop's `r2-delete` GC pass; skip those.
        stem = key[len(r2_prefix):]
        parts = stem.split('/')
        if len(parts) != 3 or not parts[2].endswith('.parquet'):
            skipped_legacy += 1
            continue
        tier, shard_dur = parts[0], parts[1]
        label = parts[2][:-len('.parquet')]
        try:
            shard_span = parse_duration(shard_dur)
        except ValueError:
            # Pre-cutover `p<X>` partial-shard prefix; not in the new ladder.
            skipped_legacy += 1
            continue
        ps_dt = _parse_period_label(label, shard_dur)
        pe_dt = add_span(ps_dt, shard_span)
        ps_ms = int(ps_dt.timestamp() * 1000)
        pe_ms = int(pe_dt.timestamp() * 1000)
        for f in (pyramid_name, tier, shard_dur, key):
            assert "'" not in f, f"single-quote in {f!r} would break SQL literal"
        lines.append(
            "INSERT INTO pyramid_shards "
            "(pyramid, tier, shard_dur, period_start, period_end, key, written_at) "
            f"VALUES ('{pyramid_name}', '{tier}', '{shard_dur}', {ps_ms}, {pe_ms}, '{key}', unixepoch()*1000) "
            "ON CONFLICT (pyramid, tier, shard_dur, period_start) DO UPDATE SET "
            "period_end=excluded.period_end, key=excluded.key, written_at=excluded.written_at;"
        )
        k = (tier, shard_dur)
        watermarks[k] = max(watermarks.get(k, 0), pe_ms)
    for (tier, shard_dur), pe_ms in watermarks.items():
        lines.append(
            "INSERT INTO pyramid_watermarks "
            "(pyramid, tier, shard_dur, latest_period_end, updated_at) "
            f"VALUES ('{pyramid_name}', '{tier}', '{shard_dur}', {pe_ms}, unixepoch()*1000) "
            "ON CONFLICT (pyramid, tier, shard_dur) DO UPDATE SET "
            "latest_period_end=MAX(excluded.latest_period_end, pyramid_watermarks.latest_period_end), "
            "updated_at=excluded.updated_at;"
        )

    Path(out_path).write_text("\n".join(lines) + "\n")
    n_shards = len(lines) - len(watermarks)
    err(f"wrote {len(lines)} statements ({n_shards} shards + "
        f"{len(watermarks)} watermarks; skipped {skipped_legacy} legacy) → {out_path}")


if __name__ == '__main__':
    main()
