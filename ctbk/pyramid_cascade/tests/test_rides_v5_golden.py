"""Golden acceptance fixtures for the rides pyramid.

Replaces the retired `rides-v5-accept` harness, which validated v5 against the
now-excised **rides-v3** pyramid as ground truth. Ground truth here is instead
the hand-counted input rides themselves — a frozen, version-agnostic anchor: the
same expected per-(station, month, dims) counts + durations that *any* correct
rides pyramid must reproduce (v5 today, a hypothetical v6 later, via its own
`semantic_counts` adapter).

The three invariants the old harness checked, re-expressed against source truth:
  1. **totals** — Σ leaf `count` over a window == the number of source rides
     anchored into it (start vs end month).
  2. **station-equiv** — per-canonical-station monthly counts (identity keying:
     a legacy alias folds into its canonical station, never a separate row).
  3. **monoid math** — `duration` sum/sumsq aggregate correctly per group.

Hermetic: builds `MonthlyRidesSource` over synthetic `normalized/<ym>.parquet`
blobs in `MemStorage` (no R2, no network), reusing the row helpers from
`test_rides_source`.
"""
from __future__ import annotations

from datetime import datetime, timezone

import polars as pl
import pytest
from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.rides_source import MonthlyRidesSource
from ctbk.pyramid_cascade.tests.test_rides_source import RIDE_SCHEMA, ride, rides_blob

YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.parquet" }
axis: time
binCol: dt
dims:
  - { name: cell,      type: string }
  - { name: gender,    type: string }
  - { name: user_type, type: string }
  - { name: bike_type, type: string }
metrics:
  - { name: count,    monoid: sum }
  - { name: duration, monoid: sum }
tiers:
  - { name: 1h, bin: 1h, shards: [32d] }
"""

# Two canonical stations, each its own vocab cell; `L` is a legacy alias of A.
CHAINS = {'A': ['cA', 's:A'], 'B': ['cB', 's:B']}
CANONICAL = {'1': 'A', '2': 'B', 'L': 'A'}
GEO: dict[str, tuple[float, float]] = {}
VOCAB_CELLS = frozenset({'cA', 'cB'})

JUN = datetime(2026, 6, 1, tzinfo=timezone.utc)
JUL = datetime(2026, 7, 1, tzinfo=timezone.utc)
AUG = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _at(day: int, hour: int, minute: int = 0, month: int = 6) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=timezone.utc)


# ─── The golden scenario ────────────────────────────────────────────────
# Rides are stored by END month, anchored (start|end) at query time. Durations
# in seconds; `r5` spills across the month boundary (starts Jun 30, ends Jul 1),
# so it anchors into June under `start` and into July under `end`.
# `end_sid` is also a canonical id so the END anchor (which keys on the end
# station) lands on `s:` identity cells too; start-anchor expectations key on
# `start_sid` and are unaffected by the end station chosen.
GOLDEN_RIDES: dict[str, list[dict]] = {
    '202606': [
        ride(_at(5, 10, 0), _at(5, 10, 10), start_sid='1', end_sid='2', gender=1, user_type='Subscriber', bike_type='classic'),   # A→B 600s
        ride(_at(5, 10, 30), _at(5, 10, 40), start_sid='1', end_sid='2', gender=1, user_type='Subscriber', bike_type='classic'),  # A→B 600s (same start group)
        ride(_at(6, 11, 0), _at(6, 11, 5), start_sid='L', end_sid='2', gender=2, user_type='Customer', bike_type='electric'),     # A (legacy alias)→B 300s
        ride(_at(7, 9, 0), _at(7, 9, 15), start_sid='2', end_sid='1', gender=1, user_type='Subscriber', bike_type='classic'),     # B→A 900s
    ],
    '202607': [
        ride(_at(30, 23, 30), _at(1, 0, 10, month=7), start_sid='2', end_sid='1', gender=1, user_type='Subscriber', bike_type='electric'),  # B→A 2400s spillback
    ],
}

# Expected per-(cell, gender, user_type, bike_type) → (ride_count, duration_sum)
# for the START anchor, JUNE window. Hand-counted from GOLDEN_RIDES above.
GOLDEN_START_JUNE = {
    ('s:A', 'male', 'Subscriber', 'classic'): (2, 1200),
    ('s:A', 'female', 'Customer', 'electric'): (1, 300),
    ('s:B', 'male', 'Subscriber', 'classic'): (1, 900),
    ('s:B', 'male', 'Subscriber', 'electric'): (1, 2400),  # r5, spilled back into June
}


@pytest.fixture
def pyramid():
    return pyramid_from_config(parse_pyramid_yaml(YAML), MemStorage())


def make_source(pyramid, anchor: str) -> MonthlyRidesSource:
    blobs = {f'normalized/{ym}.parquet': rides_blob(rows) for ym, rows in GOLDEN_RIDES.items()}
    return MonthlyRidesSource(
        pyramid, anchor,
        chains=CHAINS, canonical=CANONICAL, geo=GEO, vocab_cells=VOCAB_CELLS,
        available_months=set(GOLDEN_RIDES), fetch_fn=blobs.get,
    )


def semantic_counts(df: pl.DataFrame, prefix: str = 's:') -> dict[tuple, tuple[int, int]]:
    """v5 adapter: reduce the long-form sum-monoid rows to version-agnostic
    per-(cell, dims) (ride_count, duration_sum) over identity (`s:`) cells.
    A v6 with a different row layout supplies its own adapter to the same
    golden dicts."""
    wide = (
        df.filter(pl.col('cell').str.starts_with(prefix))
        .filter(pl.col('metric').cast(pl.Utf8).is_in(['count_sum', 'duration_sum']))
        .group_by('cell', 'gender', 'user_type', 'bike_type', 'metric')
        .agg(pl.col('count').sum().alias('v'))
    )
    out: dict[tuple, dict] = {}
    for cell, gender, ut, bt, metric, v in wide.select(
        'cell', 'gender', 'user_type', 'bike_type', pl.col('metric').cast(pl.Utf8), 'v'
    ).rows():
        out.setdefault((cell, gender, ut, bt), {})[metric] = v
    return {k: (int(m['count_sum']), int(m['duration_sum'])) for k, m in out.items()}


def test_golden_start_anchor_semantic_counts(pyramid):
    src = make_source(pyramid, 'start')
    assert semantic_counts(src.read_window(JUN, JUL)) == GOLDEN_START_JUNE


def test_golden_totals_match_source_ride_count(pyramid):
    # Σ leaf count over a window == number of source rides anchored into it.
    # start: r1-r4 start in June, r5 spills back into June → 5; none in July.
    start = make_source(pyramid, 'start')
    assert sum(c for c, _ in semantic_counts(start.read_window(JUN, JUL)).values()) == 5
    assert sum(c for c, _ in semantic_counts(start.read_window(JUL, AUG)).values()) == 0
    # end: r1-r4 end in June (4), r5 ends Jul 1 → July (1).
    end = make_source(pyramid, 'end')
    assert sum(c for c, _ in semantic_counts(end.read_window(JUN, JUL)).values()) == 4
    assert sum(c for c, _ in semantic_counts(end.read_window(JUL, AUG)).values()) == 1


def test_golden_identity_folding(pyramid):
    # The legacy alias `L` and the primary id `1` both fold into canonical A;
    # A's June count is 3 (two `1` + one `L`), never a separate `s:L` row.
    counts = semantic_counts(make_source(pyramid, 'start').read_window(JUN, JUL))
    a_total = sum(c for (cell, *_), (c, _) in counts.items() if cell == 's:A')
    assert a_total == 3
    assert not any(cell == 's:L' for (cell, *_) in counts)


def test_golden_duration_monoid_sumsq(pyramid):
    # Monoid sumsq aggregates per group: A's two 600 s classic rides →
    # duration_sumsq = 600² + 600² = 720 000 (n=2, sum=1200).
    df = make_source(pyramid, 'start').read_window(JUN, JUL)
    g = (
        df.filter((pl.col('cell') == 's:A') & (pl.col('bike_type') == 'classic'))
        .filter(pl.col('metric').cast(pl.Utf8).is_in(['duration_n', 'duration_sum', 'duration_sumsq']))
        .select(pl.col('metric').cast(pl.Utf8), 'count')
        .sort('metric')
        .rows()
    )
    assert g == [('duration_n', 2.0), ('duration_sum', 1200.0), ('duration_sumsq', 720000.0)]
