"""`gbfs_empty.lu_cadence`: 1.1 fill ticks don't count toward the 2.3 feed's cadence."""
from datetime import date, datetime, timezone

import numpy as np

from ctbk.gbfs_empty import DayPlanes, lu_cadence

DAY = date(2026, 9, 26)
T0 = int(datetime(2026, 9, 26, tzinfo=timezone.utc).timestamp())


def planes(ts: list[int]) -> DayPlanes:
    return DayPlanes(day=DAY, planes={}, n_rows=0, n_spill=0, added=[], lu_ts=np.asarray(ts, dtype=np.int64))


def test_fill_tick_excluded_from_cadence():
    # 2.3 ticks at :46 of minutes 0, 1, 3 (minute 2 missed); a 1.1 fill at 02:03.
    ts = [T0 + 46, T0 + 60 + 46, T0 + 120 + 3, T0 + 180 + 46]
    with_fill = lu_cadence(planes(ts), filled=[2])
    assert (with_fill['lu_updates'], with_fill['lu_skips'], with_fill['lu_hist']) == (3, 1, {'60': 1, '120': 1})
    # Without the exclusion the fill counts as a 2.3 update and splits the 120 s gap into
    # 17 s + 103 s intervals in the histogram.
    raw = lu_cadence(planes(ts))
    assert (raw['lu_updates'], raw['lu_skips'], raw['lu_hist']) == (4, 1, {'17': 1, '60': 1, '103': 1})
