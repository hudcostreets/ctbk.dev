"""`resolve_cross_dump_dups`: a spillover ride published in two source dumps.

A ride spanning two months appears in both the start-month and end-month Citi
Bike dumps; its attributes can drift between publications (last-ULP lat/lng
noise, station-ID fixups). Consolidating the end-month globs both copies, so the
same `(Start Time, Stop Time, Ride ID)` key is read twice. We keep the copy from
the latest source dump. See `s3/ctbk/normalized/202605.parquet` for the real
instance (499 April-start / May-end rides in both the 202604 and 202605 dumps).
"""
import pandas as pd

from ctbk.consolidated import resolve_cross_dump_dups

T0 = pd.Timestamp('2026-04-30 23:41:29.852000')
T1 = pd.Timestamp('2026-05-01 00:06:11.624000')


def _row(ride, file, end_lat):
    return {
        'Start Time': T0,
        'Stop Time': T1,
        'Ride ID': ride,
        'End Station Latitude': end_lat,
        'file': file,
    }


def test_keeps_latest_source_dump():
    # Ride R spans 202604→202605: in the 202604 dump (end_lat …151) and, drifted,
    # in the 202605 dump (…1506). Ride S occurs once. Expect: S untouched, and R
    # resolved to the 202605-dump copy only.
    df = pd.DataFrame([
        _row('R', '202605/202604_202605.parquet', 40.700763083261506),
        _row('S', '202605/202605_202605.parquet', 40.683238654603414),
        _row('R', '202604/202604_202605.parquet', 40.70076308326151),
    ])
    out = resolve_cross_dump_dups(df, name='202605')
    got = sorted(
        (r['Ride ID'], r['file'], r['End Station Latitude'])
        for _, r in out.iterrows()
    )
    assert got == [
        ('R', '202605/202604_202605.parquet', 40.700763083261506),
        ('S', '202605/202605_202605.parquet', 40.683238654603414),
    ]


def test_no_dups_is_identity():
    df = pd.DataFrame([
        _row('R', '202604/202604_202605.parquet', 40.70076308326151),
        _row('S', '202605/202605_202605.parquet', 40.683238654603414),
    ])
    out = resolve_cross_dump_dups(df, name='202605')
    assert out.equals(df)


def test_pre_2020_keys_on_bike_id_not_just_timestamps():
    # Pre-2020 data has no Ride ID: `dedupe_sort` keys on Bike ID, so must this.
    # Two distinct rides sharing a (Start, Stop) pair but differing in Bike ID are
    # NOT dups — keying on timestamps alone would wrongly collapse them.
    df = pd.DataFrame([
        {'Start Time': T0, 'Stop Time': T1, 'Bike ID': 111,
         'file': '201306/201306_201306.parquet'},
        {'Start Time': T0, 'Stop Time': T1, 'Bike ID': 222,
         'file': '201306/201306_201306.parquet'},
    ])
    out = resolve_cross_dump_dups(df, name='201306')
    assert out.equals(df)  # both kept
