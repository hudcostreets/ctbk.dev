"""`station_luc.merge_relabeled`: one GBFS UUID under a newer short_name."""
from ctbk.station_luc import merge_relabeled


def test_relabeled_short_name_collapses_to_current():
    stations = {
        '5685.04': {'lat': 40.72713, 'lng': -73.86416, 'uuid': '2206775039911987038', 'active': True},
        '5685.06': {'lat': 40.72730, 'lng': -73.86398, 'uuid': '2206775039911987038', 'active': True},
        '6022.04': {'lat': 40.73726, 'lng': -73.99239, 'uuid': '66dc741f', 'active': True},
        '496': {'lat': 40.73726, 'lng': -73.99239, 'active': False},  # historical: no uuid
    }
    by_uuid = {'2206775039911987038': '5685.06', '66dc741f': '6022.04'}
    assert merge_relabeled(stations, by_uuid) == {'5685.04': '5685.06'}
    assert sorted(stations) == ['496', '5685.06', '6022.04']
