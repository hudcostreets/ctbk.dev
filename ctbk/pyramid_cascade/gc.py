"""Pyramid GC for the Lambda executor (spec P1, final step).

Port of the CFW `gcSweep` semantics with the extended-ladder view and
a budget that clears backlogs in one run:

  eligible  = registered − expected-min-cover − raw prefix
  deletable = eligible ∧ past grace ∧ same-tier covering parent
              (strictly larger shard_dur, fully contains period,
               HEAD-verified on R2)
            ∨ eligible ∧ period_end > now (mid-period registration —
              violates the registered ⇒ complete invariant; the read
              planner would trust it through period_end while its
              content is frozen at write time, masking finer-tier
              fall-through. No parent can cover a future period; the
              live ladder independently min-covers its real content.)
  delete    = R2 object first, then the D1 row

Conservative by construction: anything uncertain is skipped and
retried next run. Runs polars/click-free (Lambda bundle).
"""
from __future__ import annotations

import time as _time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from pyrmts import list_expected_shards, parse_pyramid_yaml, pyramid_from_config
from utz import err

from .d1_http import d1_query
from .lite import AVAIL_GENESIS, R2_BUCKET, dur_min

GRACE_MS = 15 * 60_000
RAW_PREFIX = 'gbfs/'   # raw WAL + friends: never GC-eligible (rebuild backstop)


@dataclass
class GcReport:
    eligible: int = 0
    deleted: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1


def gc_sweep(
    config_yaml: str,
    *,
    now: datetime | None = None,
    pyramid_name: str = 'avail',
    dry_run: bool = False,
    max_deletes: int | None = 5000,
) -> GcReport:
    from .lambda_exec import merge_lambda_shards
    from .lite import r2_client
    from .storage import storage_from_cfg

    now = now or datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    cfg = parse_pyramid_yaml(merge_lambda_shards(config_yaml))
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))

    expected_keys = {e.key for e in list_expected_shards(pyramid, (AVAIL_GENESIS, now))}
    rows = d1_query(
        'SELECT tier, shard_dur, period_start, period_end, key, written_at '
        'FROM pyramid_shards WHERE pyramid = ?', [pyramid_name])
    err(f'gc: {len(rows)} registered, {len(expected_keys)} expected in cover')

    # Same-tier containment index: rows per tier sorted by shard_dur
    # (largest first) for parent lookup.
    by_tier: dict[str, list[dict]] = {}
    for r in rows:
        by_tier.setdefault(r['tier'], []).append(r)

    def covering_parent(r: dict) -> dict | None:
        d = dur_min(r['shard_dur'])
        for cand in by_tier[r['tier']]:
            if (dur_min(cand['shard_dur']) > d
                    and cand['period_start'] <= r['period_start']
                    and cand['period_end'] >= r['period_end']):
                return cand
        return None

    r2 = r2_client()
    report = GcReport()
    to_delete_d1: list[str] = []
    for r in rows:
        key = r['key']
        if key in expected_keys or key.startswith(RAW_PREFIX):
            continue
        report.eligible += 1
        if max_deletes is not None and report.deleted >= max_deletes:
            report.skip('budget')
            continue
        if r['period_end'] > now_ms:
            # Mid-period registration (see module docstring). Grace on
            # written_at, not period_end (which never elapses while the
            # shard is doing damage), so an in-flight writer isn't raced.
            if r['written_at'] + GRACE_MS > now_ms:
                report.skip('future-period-within-grace')
                continue
        else:
            if r['period_end'] + GRACE_MS > now_ms:
                report.skip('within-grace')
                continue
            parent = covering_parent(r)
            if parent is None:
                report.skip('no-covering-parent')
                continue
            try:
                r2.head_object(Bucket=R2_BUCKET, Key=parent['key'])
            except r2.exceptions.ClientError:
                report.skip('parent-not-on-r2')
                continue
        if dry_run:
            report.deleted += 1
            continue
        r2.delete_object(Bucket=R2_BUCKET, Key=key)
        to_delete_d1.append(key)
        report.deleted += 1

    # D1 rows in chunks (one REST call per ~40 keys).
    for i in range(0, len(to_delete_d1), 40):
        chunk = to_delete_d1[i:i + 40]
        qs = ','.join('?' * len(chunk))
        d1_query(f'DELETE FROM pyramid_shards WHERE key IN ({qs})', chunk)
    err(f'gc: eligible={report.eligible} deleted={report.deleted}'
        f'{" (dry-run)" if dry_run else ""} skipped={report.skipped}')
    return report
