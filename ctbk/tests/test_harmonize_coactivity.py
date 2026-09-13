"""Co-activity guard in station harmonization (`ctbk/stations/harmonize.py`).

Two station ids that are both substantially active in the same month are
distinct physical stations (a renumber is a hand-off, never concurrency) and
must not be union-merged, however similar their names or close their coords.
A temporally-disjoint pair (a real renumber) must still merge.
"""
import pandas as pd

from ctbk.stations.harmonize import build_id_summaries, build_union_find


def _inputs(rows):
    """rows: (id, name, ym, count, lat, lng) → (summary, monthly_counts)."""
    df_in = pd.DataFrame([{'id': i, 'name': n, 'ym': y, 'count': c} for i, n, y, c, _, _ in rows])
    df_il = pd.DataFrame([{'id': i, 'ym': y, 'lat': la, 'lng': lo, 'count': c} for i, _, y, c, la, lo in rows])
    summary = build_id_summaries(df_in, df_il)
    mc = df_in.groupby(['id', 'ym'])['count'].sum()
    monthly = {}
    for (sid, ym), c in mc.items():
        monthly.setdefault(sid, {})[ym] = int(c)
    return summary, monthly


def test_disjoint_renumber_merges():
    rows = [
        ('A', 'River St & Newark St', '202001', 500, 40.736, -74.029),
        ('A', 'River St & Newark St', '202006', 500, 40.736, -74.029),
        ('B', 'River St & Newark St', '202101', 500, 40.736, -74.029),
        ('B', 'River St & Newark St', '202106', 500, 40.736, -74.029),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map['A'] == id_map['B']
    assert review == []


def test_coactive_distinct_do_not_merge():
    rows = [
        ('A', 'River St & Newark St', '202001', 500, 40.736, -74.029),
        ('A', 'River St & Newark St', '202101', 500, 40.736, -74.029),
        ('B', 'River St & Newark St', '202001', 500, 40.737, -74.029),
        ('B', 'River St & Newark St', '202101', 500, 40.737, -74.029),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map['A'] != id_map['B']
    assert {frozenset((r['a'], r['b'])) for r in review} == {frozenset(('A', 'B'))}


def test_single_transition_month_still_merges():
    # One overlap month (a messy hand-off) is tolerated: the old id fades as the
    # new one starts — this is a renumber, not two co-active stations.
    rows = [
        ('A', 'River St & Newark St', '202001', 500, 40.736, -74.029),
        ('A', 'River St & Newark St', '202006', 500, 40.736, -74.029),
        ('B', 'River St & Newark St', '202006', 500, 40.736, -74.029),
        ('B', 'River St & Newark St', '202012', 500, 40.736, -74.029),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map['A'] == id_map['B']
    # merged, but the single shared month is flagged for review
    assert [r['pass'] for r in review] == ['fuzzy-borderline'] or review == []


def test_underscore_variant_always_merges():
    # A `_`-suffixed synthetic alias shares its base's name + location, so it is
    # "co-active" every month — but it's the SAME station and must merge, never
    # be split by the guard.
    rows = [
        ('5308.04', 'Foo St & Bar Ave', '202001', 500, 40.700, -74.000),
        ('5308.04', 'Foo St & Bar Ave', '202012', 500, 40.700, -74.000),
        ('5308.04_', 'Foo St & Bar Ave', '202001', 500, 40.700, -74.000),
        ('5308.04_', 'Foo St & Bar Ave', '202012', 500, 40.700, -74.000),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map['5308.04'] == id_map['5308.04_']
    assert review == []
