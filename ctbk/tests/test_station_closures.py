from datetime import date, timedelta

from pandas import DataFrame

from ctbk.stations.closures import Closure, closures, closures_by_id


def obs(rows: list[tuple[str, str, str]]) -> DataFrame:
    return DataFrame(rows, columns=['date', 'id', 'name'])


def days(start: date, n: int) -> list[str]:
    return [(start + timedelta(d)).strftime('%y%m%d') for d in range(n)]


def test_closure_bracketed_by_activity():
    # `a` runs all 40 days; `b` (old id `b0` → same canonical) is dark days 10–24.
    all_days = days(date(2024, 1, 1), 40)
    rows = [(d, 'a', 'A St') for d in all_days]
    rows += [(d, 'b0', 'B St (old)') for d in all_days[:10]]
    rows += [(d, 'b', 'B St') for d in all_days[25:]]
    canon = {'s:b0': 'c:b', 's:b': 'c:b'}
    assert closures(obs(rows), canon, min_days=5, min_active=5) == [
        Closure('c:b', 'B St', date(2024, 1, 11), date(2024, 1, 25), 15),
    ]


def test_system_outage_days_dont_count():
    # Days 10–19 have no observations anywhere: not a closure.
    all_days = days(date(2024, 1, 1), 40)
    live = all_days[:10] + all_days[20:]
    rows = [(d, 'a', 'A St') for d in live]
    assert closures(obs(rows), {}, min_days=5, min_active=5) == []


def test_needs_activity_on_both_sides():
    all_days = days(date(2024, 1, 1), 40)
    rows = [(d, 'a', 'A St') for d in all_days]
    rows += [(d, 'b', 'B St') for d in all_days[:3] + all_days[20:]]
    assert closures(obs(rows), {}, min_days=5, min_active=5) == []


def test_closures_by_id():
    found = [
        Closure('c:b', 'B St', date(2024, 6, 1), date(2024, 6, 30), 30),
        Closure('c:b', 'B St', date(2023, 1, 11), date(2023, 1, 25), 15),
        Closure('c:d', 'D St', date(2022, 3, 1), date(2022, 4, 1), 32),
    ]
    canon = {'s:b0': 'c:b', 's:b': 'c:b', 's:a0': 'c:a'}
    b = [['2023-01-11', '2023-01-25'], ['2024-06-01', '2024-06-30']]
    assert closures_by_id(found, canon) == {
        'b': b,
        'b0': b,
        'd': [['2022-03-01', '2022-04-01']],
    }
