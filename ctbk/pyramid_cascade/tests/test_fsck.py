"""Tests for fsck discovery — in particular the `stale_before`
content-invalidation knob (treat shards older than T as missing) and
its interaction with the expected-set diff.

Regression context (2026-07-16): the avail-v3 LUC re-key rebuilt shards
via the block engine + fsck-fill, but fsck's HEAD-skip idempotency
meant stale-content shards (built against the OLD station-luc denorm,
e.g. `/1m@2d` lambda rungs) were skipped — the pyramid kept serving
old-denorm data at exactly the rungs the GC sweep's min-cover prefers.
`stale_before` closes that hole: existing shards last-modified before
the given timestamp are treated as gaps and rebuilt in place.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pyrmts import Dim, ExpectedShard, Metric, Pyramid, Tier
from pyrmts.storage import MemStorage

from ctbk.pyramid_cascade.fsck import _group_by_tier, discover_gaps, split_stale

T0 = datetime(2026, 7, 15, 23, 21, tzinfo=timezone.utc)
OLD = datetime(2026, 7, 12, 0, 0, tzinfo=timezone.utc)
NEW = datetime(2026, 7, 16, 2, 30, tzinfo=timezone.utc)


class TestSplitStale:
    def test_no_cutoff_all_fresh(self):
        existing = {'a': OLD, 'b': NEW, 'c': None}
        assert split_stale(existing, None) == ({'a', 'b', 'c'}, set())

    def test_cutoff_partitions_by_mtime(self):
        existing = {'a': OLD, 'b': NEW}
        assert split_stale(existing, T0) == ({'b'}, {'a'})

    def test_unknown_mtime_is_fresh(self):
        """Backends that can't report mtimes must not trigger rebuilds."""
        existing = {'a': None, 'b': OLD}
        assert split_stale(existing, T0) == ({'a'}, {'b'})

    def test_exact_boundary_is_fresh(self):
        """`mtime == stale_before` is fresh (strict `<` comparison)."""
        existing = {'a': T0}
        assert split_stale(existing, T0) == ({'a'}, set())


class TestGroupByTier:
    def test_rungs_within_a_tier_share_one_batch(self):
        """A tier's rungs (already dependency-sorted) form ONE parallel
        layer — grouping per (tier, rung) would serialize the common
        coarse-tier tail of 1-2 shards per rung."""
        def shard(tier, dur, day):
            ps = datetime(2026, 7, day, tzinfo=timezone.utc)
            return ExpectedShard(tier=tier, shard_dur=dur, period_start=ps,
                                 period_end=ps, effective_start=ps, effective_end=ps,
                                 key=f'{tier}/{dur}/{day}')
        gaps = [
            shard('30m', '8d', 1), shard('30m', '32d', 2), shard('30m', '64d', 3),
            shard('1h', '8d', 4), shard('1h', '128d', 5),
        ]
        batches = _group_by_tier(gaps)
        assert [(t, [g.key for g in b]) for t, b in batches] == [
            ('30m', ['30m/8d/1', '30m/32d/2', '30m/64d/3']),
            ('1h', ['1h/8d/4', '1h/128d/5']),
        ]


@pytest.fixture
def pyramid() -> Pyramid:
    """Two-tier pyramid, 1d shards, over MemStorage (mtimes unavailable
    → `list_existing_with_mtime` falls back to `list()` + None mtimes)."""
    return Pyramid(
        storage=MemStorage(),
        keyTemplate='fsck-test/{tier}/{shard}/{period}.parquet',
        binCol='dt',
        dims=[Dim(name='s2_cell', type='string')],
        metrics=[Metric(name='bikes', monoid='histogram')],
        tiers=[
            Tier(name='1m', bin='1min', shards=('1d',)),
            Tier(name='2m', bin='2min', shards=('1d',)),
        ],
    )


class _MtimeStorage(MemStorage):
    """MemStorage with caller-pinned per-key mtimes (overriding the
    real-clock mtimes MemStorage tracks), so `stale_before` cutoffs can
    be exercised against a fixed history."""

    def __init__(self, mtimes: dict[str, datetime]):
        super().__init__()
        # NB: not `_mtimes` — MemStorage tracks real-clock mtimes there.
        self._pinned = mtimes
        for key in mtimes:
            self.put(key, b'x')

    def list_with_mtime(self, prefix: str):
        return [
            (k, m) for k, m in sorted(self._pinned.items())
            if k.startswith(prefix)
        ]


def _expected_keys(pyramid: Pyramid, time_range) -> list[str]:
    from pyrmts import list_expected_shards
    return [e.key for e in list_expected_shards(pyramid, time_range)]


def test_discover_gaps_stale_before_rebuilds_old_shards(pyramid):
    """Both expected 1-day shards exist, but one predates the cutoff —
    discovery must report exactly that one as a gap, and exclude it
    from the existing-keys snapshot handed to the fill loop."""
    time_range = (
        datetime(2026, 7, 14, tzinfo=timezone.utc),
        datetime(2026, 7, 16, tzinfo=timezone.utc),
    )
    keys = _expected_keys(pyramid, time_range)
    day1 = [k for k in keys if '2026-07-14' in k]
    day2 = [k for k in keys if '2026-07-15' in k]
    assert len(day1) + len(day2) == len(keys)

    mtimes = {k: OLD for k in day1} | {k: NEW for k in day2}
    pyramid.storage = _MtimeStorage(mtimes)

    missing, existing_keys, _ = discover_gaps(pyramid, time_range, stale_before=T0)
    assert sorted(g.key for g in missing) == sorted(day1)
    assert existing_keys == set(day2)


def test_discover_gaps_no_stale_before_skips_all_existing(pyramid):
    """Without the cutoff, every on-storage key counts as present."""
    time_range = (
        datetime(2026, 7, 14, tzinfo=timezone.utc),
        datetime(2026, 7, 16, tzinfo=timezone.utc),
    )
    keys = _expected_keys(pyramid, time_range)
    pyramid.storage = _MtimeStorage({k: OLD for k in keys})

    missing, existing_keys, _ = discover_gaps(pyramid, time_range)
    assert missing == []
    assert existing_keys == set(keys)
