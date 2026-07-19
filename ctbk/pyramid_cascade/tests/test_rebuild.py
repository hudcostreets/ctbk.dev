"""Tests for the fan-out rebuild driver's scaffold planning
(`specs/done/avail-v3-lambda-rebuild.md`).

Regression context (2026-07-16, first full `-T` dress rehearsal): a
rebuilt-from-scratch max-rung shard has no fresh sub-rungs to concat
(GC swept them long ago), so its build degenerated to a whole-period
fill — `/1m@2d` = 2880 raw minutes, which timed out at the hard 900 s
Lambda cap (28 timeouts before the driver was killed; `/1m@12h` = 720
minutes took 258 s). Scaffold layers cap every invocation's fill at
`SOURCE_BIN_BUDGET` source bins.
"""
from __future__ import annotations

from datetime import datetime, timezone

from pyrmts import Dim, ExpectedShard, Metric, Pyramid, Tier, parse_pyramid_yaml, pyramid_from_config
from pyrmts.storage import MemStorage

from ctbk.pyramid_cascade.lambda_exec import merge_lambda_shards
from ctbk.pyramid_cascade.rebuild import expand_scaffolds, fill_safe_rung


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


class TestFillSafeRung:
    def test_avail_ladder(self):
        """Pin the fill-safe rung of every tier in the REAL merged avail
        ladder: largest rung with ≤720 source bins (raw minutes at /1m;
        source-tier bins elsewhere)."""
        config = (
            __import__('pathlib').Path(__file__).parents[3]
            / 'configs/pyramids/avail.yaml'
        ).read_text()
        cfg = parse_pyramid_yaml(merge_lambda_shards(config))
        pyramid = pyramid_from_config(cfg, MemStorage())
        assert {t.name: fill_safe_rung(pyramid, t) for t in pyramid.tiers} == {
            '1m': '12h',    # raw source: 720 min
            '2m': '12h',    # /1m source: 720 bins
            '3m': '12h',
            '5m': '12h',
            '10m': '2d',    # /5m source: 576 bins
            '15m': '2d',
            '30m': '4d',    # /15m source: 384 bins
            '1h': '8d',     # /30m source: 384 bins
            '2h': '16d',    # /1h source: 384 bins
            '3h': '16d',    # /1h source: 384 bins
            '6h': '64d',    # /3h source: 512 bins
            '12h': '128d',  # /6h source: 512 bins
            '1d': '256d',   # /12h source: 512 bins
            '3d': '384d',   # /1d source: 384 bins
            '7d': '448d',   # /1d source: 448 bins
        }


def _pyramid() -> Pyramid:
    """One finest tier (raw-sourced), rungs 12h < 1d < 2d; fill-safe is
    12h (720 raw minutes), so 1d and 2d rungs get 12h scaffolds."""
    return Pyramid(
        storage=MemStorage(),
        keyTemplate='avail-v3/{tier}/{shard}/{period}.parquet',
        binCol='dt',
        dims=[Dim(name='s2_cell', type='string')],
        metrics=[Metric(name='bikes', monoid='histogram')],
        tiers=[Tier(name='1m', bin='1min', shards=('12h', '1d', '2d'))],
    )


def _gap(rung: str, start: str, end: str) -> ExpectedShard:
    from ctbk.pyramid_cascade.lambda_exec import _shard_key
    return ExpectedShard(
        tier='1m', shard_dur=rung,
        period_start=_dt(start), period_end=_dt(end),
        effective_start=_dt(start), effective_end=_dt(end),
        key=_shard_key(_pyramid(), '1m', rung, _dt(start)),
    )


class TestExpandScaffolds:
    def test_safe_rung_passes_through(self):
        gap = _gap('12h', '2026-04-10T00:00', '2026-04-10T12:00')
        assert expand_scaffolds(_pyramid(), [('1m', '12h', [gap])]) == [
            ('1m', '12h', [gap], False),
        ]

    def test_big_rung_gets_scaffold_layer(self):
        gap = _gap('1d', '2026-04-10T00:00', '2026-04-11T00:00')
        layers = expand_scaffolds(_pyramid(), [('1m', '1d', [gap])])
        assert [(t, r, [g.key for g in b], s) for t, r, b, s in layers] == [
            ('1m', '12h', [
                'avail-v3/1m/12h/2026-04-10T00.parquet',
                'avail-v3/1m/12h/2026-04-10T12.parquet',
            ], True),
            ('1m', '1d', ['avail-v3/1m/1d/2026-04-10.parquet'], False),
        ]

    def test_scaffolds_dedupe_across_rungs(self):
        """A 2d gap overlapping an earlier 1d gap only adds the slots
        the 1d layer didn't already plan."""
        gap_1d = _gap('1d', '2026-04-10T00:00', '2026-04-11T00:00')
        gap_2d = _gap('2d', '2026-04-10T00:00', '2026-04-12T00:00')
        layers = expand_scaffolds(
            _pyramid(),
            [('1m', '1d', [gap_1d]), ('1m', '2d', [gap_2d])],
        )
        assert [(t, r, [g.key for g in b], s) for t, r, b, s in layers] == [
            ('1m', '12h', [
                'avail-v3/1m/12h/2026-04-10T00.parquet',
                'avail-v3/1m/12h/2026-04-10T12.parquet',
            ], True),
            ('1m', '1d', ['avail-v3/1m/1d/2026-04-10.parquet'], False),
            ('1m', '12h', [
                'avail-v3/1m/12h/2026-04-11T00.parquet',
                'avail-v3/1m/12h/2026-04-11T12.parquet',
            ], True),
            ('1m', '2d', ['avail-v3/1m/2d/2026-04-10.parquet'], False),
        ]

    def test_pre_genesis_slots_skipped(self):
        """AVAIL_GENESIS is 2026-04-07T01:15; scaffold slots ending at or
        before it can never have data (same exclusion as gaps)."""
        gap = _gap('2d', '2026-04-06T00:00', '2026-04-08T00:00')
        layers = expand_scaffolds(_pyramid(), [('1m', '2d', [gap])])
        assert [(t, r, [g.key for g in b], s) for t, r, b, s in layers] == [
            ('1m', '12h', [
                'avail-v3/1m/12h/2026-04-07T00.parquet',
                'avail-v3/1m/12h/2026-04-07T12.parquet',
            ], True),
            ('1m', '2d', ['avail-v3/1m/2d/2026-04-06.parquet'], False),
        ]

    def test_scaffold_shards_carry_period_bounds(self):
        gap = _gap('1d', '2026-04-10T00:00', '2026-04-11T00:00')
        (_, _, slots, _), _ = expand_scaffolds(_pyramid(), [('1m', '1d', [gap])])
        assert [(s.period_start, s.period_end, s.shard_dur) for s in slots] == [
            (_dt('2026-04-10T00:00'), _dt('2026-04-10T12:00'), '12h'),
            (_dt('2026-04-10T12:00'), _dt('2026-04-11T00:00'), '12h'),
        ]
