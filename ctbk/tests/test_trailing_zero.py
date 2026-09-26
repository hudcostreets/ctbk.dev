"""`ctbk.stations.trailing_zero`: detect / un-corrupt / attribute the `cons`
trailing-zero id corruption, on a replica of `364` (Lafayette Ave & Classon
Ave, Brooklyn) folded into `3640` (Journal Square, JC)."""
import pandas as pd

from ctbk.stations.trailing_zero import Pair, detect_pairs, regional_impact, repairs, uncorrupt

BK = (40.6890, -73.9600)
JSQ = (40.7340, -74.0620)
STATIONS = {
    '4452.01': {'lat': BK[0], 'lng': BK[1], 'region': 'NYC'},
    'JC103': {'lat': JSQ[0], 'lng': JSQ[1], 'region': 'JC'},
}

# Corrupted meta_hists: 364 exists only before 201710; from then on its rows
# sit under 3640 alongside Journal Square's.
DIN = pd.DataFrame([
    ('364', 'Lafayette Ave & Classon Ave', '201709', 2000),
    ('3640', 'Lafayette Ave & Classon Ave', '201710', 2500),
    ('3640', 'Journal Square', '201710', 600),
    ('3640', 'Journal Square', '202001', 700),
    ('4452.01', 'Lafayette Ave & Classon Ave', '202001', 3000),
    ('JC103', 'Journal Square', '202102', 800),
], columns=['id', 'name', 'ym', 'count'])
DIL = pd.DataFrame([
    ('364', '201709', *BK, 2000),
    ('3640', '201710', *BK, 2500),
    ('3640', '201710', *JSQ, 600),
    ('3640', '202001', *JSQ, 700),
    ('4452.01', '202001', *BK, 3000),
    ('JC103', '202102', *JSQ, 800),
], columns=['id', 'ym', 'lat', 'lng', 'count'])


def test_detect_and_uncorrupt():
    pairs = detect_pairs(DIN)
    assert pairs == [Pair('364', '3640', frozenset({'Lafayette Ave & Classon Ave'}))]
    din, dil = uncorrupt(DIN, DIL, pairs)
    assert sorted(din.itertuples(index=False, name=None)) == [
        ('364', 'Lafayette Ave & Classon Ave', '201709', 2000),
        ('364', 'Lafayette Ave & Classon Ave', '201710', 2500),
        ('3640', 'Journal Square', '201710', 600),
        ('3640', 'Journal Square', '202001', 700),
        ('4452.01', 'Lafayette Ave & Classon Ave', '202001', 3000),
        ('JC103', 'Journal Square', '202102', 800),
    ]
    assert dil['id'].tolist() == ['364', '364', '3640', '3640', '4452.01', 'JC103']


def test_repairs_move_jc_rides_out_of_brooklyn():
    pairs = detect_pairs(DIN)
    din, dil = uncorrupt(DIN, DIL, pairs)
    idm_before = {'364': '4452.01', '3640': '4452.01', '4452.01': '4452.01', 'JC103': 'JC103'}
    idm_after = {'364': '4452.01', '3640': 'JC103', '4452.01': '4452.01', 'JC103': 'JC103'}
    [r] = repairs(DIN, din, dil, pairs, idm_before, idm_after, STATIONS)
    assert (r['before']['canon'], r['before']['region']) == ('4452.01', 'NYC')
    assert {k: (v['canon'], v['region']) for k, v in r['after'].items()} == {'364': ('4452.01', 'NYC'), '3640': ('JC103', 'JC')}
    assert r['series'] == {'201710': [2500, 600], '202001': [0, 700]}
    assert r['months'] == ['201710']
    impact = regional_impact([r])
    assert impact.reset_index().to_dict('records') == [
        {'ym': '201710', 'region': 'JC', 'before': 0, 'after': 600, 'delta': 600},
        {'ym': '201710', 'region': 'NYC', 'before': 3100, 'after': 2500, 'delta': -600},
        {'ym': '202001', 'region': 'JC', 'before': 0, 'after': 700, 'delta': 700},
        {'ym': '202001', 'region': 'NYC', 'before': 700, 'after': 0, 'delta': -700},
    ]
