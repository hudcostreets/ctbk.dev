from datetime import date

from ctbk.gbfs_raw_gc import DayPlan, gc_days, merge_manifest, plan_day

DAY = '2026-08-01'
T0 = 1_785_542_400  # 2026-08-01T00:00Z
SHA = 'ab' * 32


def ts(h: int, m: int, s: int = 0) -> int:
    return T0 + h * 3600 + m * 60 + s


def wal(*hms: tuple[int, int, int]) -> dict[str, int]:
    """WAL alias key (poll minute) → the LU `ts` it records."""
    return {f'gbfs/status/{DAY}/{h:02d}-{m:02d}.json': ts(h, m, s) for h, m, s in hms}


def gen(*t: int) -> list[str]:
    return [f'gbfs/status-generation/{DAY}/{x}.json' for x in t]


def v11(*hm: tuple[int, int]) -> list[str]:
    return [f'gbfs/probe/v11/{DAY}/{h:02d}-{m:02d}.json' for h, m in hm]


def test_covered_day():
    # 00:00 and 00:01 captured by 2.3 (00:01's alias repeats 00:00's LU); 00:02
    # only by the 1.1 backup (a fill); 00:00 also seen by 1.1 (redundant).
    pq = {ts(0, 0, 46), ts(0, 2, 3), ts(0, 3, 46)}
    plan = plan_day(
        DAY, pq,
        wal=wal((0, 0, 46), (0, 1, 46 - 60)) | {f'gbfs/status/{DAY}/00-03.json': ts(0, 3, 46)},
        generations=[*gen(ts(0, 3, 46)), f'gbfs/status-generation/{DAY}/{ts(0, 3, 46)}-{SHA}.json'],
        v11=v11((0, 0), (0, 2)),
    )
    assert plan == DayPlan(
        day=DAY,
        delete=[
            *v11((0, 0), (0, 2)),
            f'gbfs/status-generation/{DAY}/{ts(0, 3, 46)}-{SHA}.json',
            *gen(ts(0, 3, 46)),
            f'gbfs/status/{DAY}/00-00.json',
            f'gbfs/status/{DAY}/00-01.json',
            f'gbfs/status/{DAY}/00-03.json',
        ],
        variants=[f'gbfs/status-generation/{DAY}/{ts(0, 3, 46)}-{SHA}.json'],
        filled=[2],
        counts={'wal': 3, 'generations': 2, 'v11': 2},
    )


def test_uncovered_day_deletes_nothing():
    plan = plan_day(
        DAY, {ts(0, 0, 46)},
        wal=wal((0, 0, 46), (0, 1, 46)),
        generations=gen(ts(0, 5, 0)) + [f'gbfs/status-generation/{DAY}/junk.json'],
        v11=v11((0, 0), (0, 7)) + [f'gbfs/probe/v11/{DAY}/x.json'],
    )
    assert plan == DayPlan(day=DAY, problems=[
        f'gbfs/status/{DAY}/00-01.json: ts {ts(0, 1, 46)} not in parquet',
        f'gbfs/status-generation/{DAY}/{ts(0, 5, 0)}.json: ts not in parquet',
        f'unexpected generation key gbfs/status-generation/{DAY}/junk.json',
        f'gbfs/probe/v11/{DAY}/00-07.json: no parquet LU in that minute',
        f'unexpected v11 key gbfs/probe/v11/{DAY}/x.json',
    ])


def test_missing_parquet():
    assert plan_day(DAY, None, wal((0, 0, 46)), [], []) == DayPlan(day=DAY, problems=[f'no gbfs/status/{DAY}.parquet'])


def test_merge_manifest_accumulates_partial_runs():
    parquet = {'key': f'gbfs/status/{DAY}.parquet', 'etag': 'e', 'size': 9, 'rows': 6, 'lus': 3}
    first = DayPlan(DAY, delete=['a'], variants=[f'gbfs/status-generation/{DAY}/1-{SHA}.json'], filled=[2, 5], counts={'wal': 0, 'generations': 1, 'v11': 3})
    m1 = merge_manifest(None, first, parquet, 100, '2026-11-24T01:00:00Z')
    # A rerun after an interrupted delete: v11 already gone, so `filled` is
    # empty this time and must not erase the first run's.
    second = DayPlan(DAY, delete=['b'], counts={'wal': 1440, 'generations': 0, 'v11': 0})
    assert merge_manifest(m1, second, parquet, 50, '2026-11-25T01:00:00Z') == {
        'day': DAY,
        'parquet': parquet,
        'deleted': {'wal': 1440, 'generations': 1, 'v11': 3},
        'bytes': 150,
        'variants': [f'gbfs/status-variants/{DAY}/1-{SHA}.json'],
        'filled': [2, 5],
        'runs': ['2026-11-24T01:00:00Z', '2026-11-25T01:00:00Z'],
    }


def test_gc_days_cutoff():
    days = {'2026-08-24', '2026-08-25', '2026-08-26', '2026-11-23'}
    assert gc_days(date(2026, 11, 24), 90, days) == ['2026-08-24', '2026-08-25']
