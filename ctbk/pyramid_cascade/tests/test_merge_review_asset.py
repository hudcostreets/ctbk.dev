"""`rides_assets.merge_clusters`: the `/merge-review` page's per-cluster facts
(`specs/rides-rekey.md` P5). Hermetic — inputs inlined."""
from __future__ import annotations

from ctbk.pyramid_cascade.rides_assets import merge_clusters


def test_merge_clusters():
    # `c:6148.02`: the {116 → 6148.02} renumber (harmonize), where 116 had two
    # name eras. `c:A`: harmonize sent `1` to A; `L` was folded in by the luc
    # overlay (id-map says `L`→`L`) and has no history/position yet.
    canon_map = {'s:116': 'c:6148.02', 's:6148.02': 'c:6148.02', 's:1': 'c:A', 's:L': 'c:A'}
    id_map = {'116': '6148.02', '6148.02': '6148.02', '1': 'A', 'L': 'L', '999': '999'}
    spans = [
        {'id': '6148.02', 'name': 'Broadway & W 60 St', 'first': '210203', 'last': None},
        {'id': '116', 'name': 'W 17 St & 8 Ave', 'first': '150102', 'last': '210201'},
        {'id': '116', 'name': 'W 17 St & 8th Ave', 'first': '130601', 'last': '150101'},
        {'id': '1', 'name': 'One', 'first': '202007', 'last': '202007'},  # month-level (`YYYYMM`) fallback span
        {'id': '999', 'name': 'Unmerged', 'first': '200101', 'last': None},
    ]
    geo = {'116': (40.7417, -74.0018), '6148.02': (40.7417, -74.0017), '1': (40.7, -74.0)}
    review = [
        {'pass': 'fuzzy-borderline', 'a': '1', 'b': 'L', 'shared_months': ['200105'], 'merged': True},
        {'pass': 'exact-name', 'a': '116', 'b': '999', 'shared_months': ['200101', '200102']},
        {'pass': 'fuzzy', 'a': 'X', 'b': 'Y', 'shared_months': ['200101']},
    ]
    assert merge_clusters(canon_map, id_map, spans, geo, review) == {
        '6148.02': {
            'members': [
                {'id': '116', 'via': 'harmonize', 'pos': [40.7417, -74.0018], 'spans': [
                    ['W 17 St & 8th Ave', '2013-06-01', '2015-01-01'],
                    ['W 17 St & 8 Ave', '2015-01-02', '2021-02-01'],
                ]},
                {'id': '6148.02', 'via': 'harmonize', 'pos': [40.7417, -74.0017], 'spans': [
                    ['Broadway & W 60 St', '2021-02-03', None],
                ]},
            ],
            'review': [review[1]],
        },
        'A': {
            'members': [
                {'id': '1', 'via': 'harmonize', 'pos': [40.7, -74.0], 'spans': [['One', '2020-07-01', '2020-07-01']]},
                {'id': 'L', 'via': 'overlay', 'pos': None, 'spans': []},
            ],
            'review': [review[0]],
        },
    }
