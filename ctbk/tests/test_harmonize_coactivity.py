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


def test_guard_sees_transitive_group():
    # `5947.06` "E 15 St & 5 Ave" (2024→) and `6022.04` "E 16 St & 5 Ave"
    # (2020→) are concurrently busy docks a block apart. They never meet
    # directly (names differ only by the street number), but both fuzzy-match
    # the 58-ride `6022.04_Pillar` alias; a guard that only checked the ids
    # being joined let E 15 St reach E 16 St through it.
    rows = [
        ('496', 'E 16 St & 5 Ave', '201306', 9000, 40.73726, -73.99239),
        ('496', 'E 16 St & 5 Ave', '201912', 9000, 40.73726, -73.99239),
        ('6022.04', 'E 16 St & 5 Ave', '202001', 9000, 40.73726, -73.99239),
        ('6022.04', 'E 16 St & 5 Ave', '202407', 9000, 40.73726, -73.99239),
        ('6022.04', 'E 16 St & 5 Ave', '202607', 9000, 40.73726, -73.99239),
        ('6022.04_Pillar', 'Pillar E 16 St & 5 Ave', '202311', 58, 40.73726, -73.99239),
        ('5947.06', 'E 15 St & 5 Ave', '202407', 5000, 40.73659, -73.99295),
        ('5947.06', 'E 15 St & 5 Ave', '202607', 5000, 40.73659, -73.99295),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert {k: id_map[k] for k in ('496', '6022.04', '6022.04_Pillar', '5947.06')} == {
        '496': '6022.04', '6022.04': '6022.04', '6022.04_Pillar': '6022.04', '5947.06': '5947.06',
    }
    assert [(r['pass'], r['a'], r['b'], r['shared_months']) for r in review] == [
        ('fuzzy', '5947.06', '6022.04_Pillar', ['202407', '202607']),
    ]


def test_underscore_variant_joins_multi_id_group():
    # The variant exemption applies pairwise: `5303.06_` is co-active with its
    # base `5303.06` (exempt), and never with the base's predecessor `350`.
    rows = [
        ('350', 'Clinton St & Grand St', '201306', 5000, 40.7156, -73.9870),
        ('350', 'Clinton St & Grand St', '201912', 5000, 40.7156, -73.9870),
        ('5303.06', 'Clinton St & Grand St', '202001', 5000, 40.7156, -73.9870),
        ('5303.06', 'Clinton St & Grand St', '202507', 5000, 40.7156, -73.9870),
        ('5303.06', 'Clinton St & Grand St', '202607', 5000, 40.7156, -73.9870),
        ('5303.06_', 'Clinton St & Grand St', '202507', 3000, 40.7157, -73.9870),
        ('5303.06_', 'Clinton St & Grand St', '202607', 3000, 40.7157, -73.9870),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert {id_map[k] for k in ('350', '5303.06', '5303.06_')} == {'5303.06'}
    assert review == []


def test_same_dock_overlap_still_merges():
    # `6960.12` took over "3 Ave & E 71 St" from `6960.10` ~25 m away, the
    # two overlapping for a few months: one dock's relocation, not two
    # stations. (A same-name pair farther apart than `SAME_DOCK_M` stays
    # subject to the guard.)
    rows = [
        ('6960.10', '3 Ave & E 71 St', '202001', 5000, 40.76874, -73.96120),
        ('6960.10', '3 Ave & E 71 St', '202311', 5000, 40.76874, -73.96120),
        ('6960.10', '3 Ave & E 71 St', '202406', 5000, 40.76874, -73.96120),
        ('6960.12', '3 Ave & E 71 St', '202311', 5000, 40.76879, -73.96140),
        ('6960.12', '3 Ave & E 71 St', '202406', 5000, 40.76879, -73.96140),
        ('6960.12', '3 Ave & E 71 St', '202607', 5000, 40.76879, -73.96140),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map['6960.10'] == id_map['6960.12'] == '6960.12'
    assert review == []


def test_strongest_fuzzy_match_wins():
    # `3091` "Frost St & Meeker St" is the predecessor of `5371.07` "Frost St &
    # Meeker Ave"; `3089` "Leonard St & Meeker Ave" (~60 m away) was co-active
    # with `3091`. Whichever joins `5371.07` first blocks the other, so the
    # closer name must be applied first.
    rows = [
        ('3089', 'Leonard St & Meeker Ave', '201511', 500, 40.71732, -73.94820),
        ('3089', 'Leonard St & Meeker Ave', '201611', 500, 40.71732, -73.94820),
        ('3091', 'Frost St & Meeker St', '201511', 500, 40.71764, -73.94882),
        ('3091', 'Frost St & Meeker St', '201611', 500, 40.71764, -73.94882),
        ('3091', 'Frost St & Meeker St', '201812', 500, 40.71764, -73.94882),
        ('5371.07', 'Frost St & Meeker Ave', '202001', 500, 40.71766, -73.94880),
        ('5371.07', 'Frost St & Meeker Ave', '202607', 500, 40.71766, -73.94880),
    ]
    summary, monthly = _inputs(rows)
    review = []
    id_map = build_union_find(summary, monthly, review)
    assert id_map == {'3089': '3089', '3091': '5371.07', '5371.07': '5371.07'}
    assert [(r['pass'], r['shared_months']) for r in review] == [('fuzzy', ['201511', '201611'])]
