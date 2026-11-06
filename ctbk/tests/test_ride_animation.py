from datetime import datetime, timedelta
from gzip import decompress
from json import loads

import polars as pl
import pytest
from click.testing import CliRunner

from ctbk.ride_animation import CAP, Ride, build_month, decode_day, encode_day
from ctbk.ride_animation_cli import animation_months, extend, submit

GOLDEN = bytes.fromhex('43545241010003000300000001000000130a0514001e00302a000001000200010002000000000105')
ROWS = [Ride(-10, 20, 0, 1, 0), Ride(0, 30, 1, 2, 1), Ride(5, CAP, 2, 0, 5)]


def test_golden_round_trip():
    assert encode_day(ROWS, 3, 1) == GOLDEN
    assert decode_day(GOLDEN) == (3, 1, ROWS)


@pytest.mark.parametrize('data', [GOLDEN[:15], GOLDEN[:-1], GOLDEN + b'\0', b'NOPE' + GOLDEN[4:]])
def test_rejects_corrupt_files(data):
    with pytest.raises(ValueError):
        decode_day(data)


def test_empty_day():
    data = bytes.fromhex('43545241010000000000000000000000')
    assert encode_day([], 0, 0) == data
    assert decode_day(data) == (0, 0, [])


def test_month_range_crosses_year_boundary():
    assert animation_months('202511-202602') == ['202511', '202512', '202601', '202602']


def test_batch_dry_run_is_an_exact_plan_without_aws_calls(monkeypatch):
    def unexpected_client(*args, **kwargs):
        raise AssertionError('dry run must not access AWS')
    monkeypatch.setattr('boto3.client', unexpected_client)
    image = '688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:1234abcd'
    result = CliRunner().invoke(submit, ['-d', '202512-202601', '-s', image, '-n'])
    assert result.exit_code == 0
    assert loads(result.stdout) == {
        'queue': 'ctbk-reproc', 'image': image, 'months': 2, 'vcpus': 4, 'memory': 8192,
        'command': ['script', 'exec ctbk rides-anim backfill -d 202512-202601 -k rides-anim-candidate/v1 -u'],
    }


def test_monthly_extend_refolds_the_previous_start_month_without_cloud_calls(monkeypatch):
    def unexpected_client(*args, **kwargs):
        raise AssertionError('dry run must not access AWS')
    monkeypatch.setattr('boto3.client', unexpected_client)
    ref = '1234abcd' * 5
    monkeypatch.setattr('ctbk.ride_animation_cli.animation_assets_ref', lambda: ref)
    result = CliRunner().invoke(extend, ['-d', '202601', '-n'])
    assert result.exit_code == 0
    assert loads(result.stdout) == {
        'queue': 'ctbk-reproc', 'image': '688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:1a7fdd1d',
        'months': 2, 'vcpus': 4, 'memory': 8192,
        'useExistingJobDefinition': True,
        'assetsRef': ref,
        'command': ['script', f'git fetch -q origin {ref} && git checkout -q FETCH_HEAD -- s3/ctbk/stations/station-id-map.json www/public/assets/station-luc.json gbfs/engine/station-geo.json && exec ctbk rides-anim backfill -d 202512-202601 -k rides-anim-candidate/v1 -u'],
    }


def test_existing_job_definition_submits_only_and_overrides_the_month_range(monkeypatch):
    image = '688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:1234abcd'
    arn = 'arn:aws:batch:us-east-1:688066488567:job-definition/ctbk-reproc-animation:1'
    calls = []
    class Batch:
        def describe_job_definitions(self, **kwargs):
            assert kwargs == {'jobDefinitionName': 'ctbk-reproc-animation', 'status': 'ACTIVE'}
            return {'jobDefinitions': [{'revision': 1, 'jobDefinitionArn': arn, 'containerProperties': {'image': image}}]}
        def submit_job(self, **kwargs):
            calls.append(kwargs)
            return {'jobId': 'job-id'}
        def register_job_definition(self, **kwargs):
            raise AssertionError('monthly submission must not register definitions')
    class STS:
        def get_caller_identity(self):
            return {'Account': '688066488567'}
    def client(name, **kwargs):
        if name == 'sts':
            return STS()
        assert (name, kwargs) == ('batch', {'region_name': 'us-east-1'})
        return Batch()
    monkeypatch.setattr('boto3.client', client)
    result = CliRunner().invoke(submit, ['-d', '202512-202601', '-s', image, '-e'])
    assert result.exit_code == 0
    command = ['script', 'exec ctbk rides-anim backfill -d 202512-202601 -k rides-anim-candidate/v1 -u']
    assert calls == [{
        'jobName': 'rides-anim-202512-202601', 'jobQueue': 'ctbk-reproc', 'jobDefinition': arn,
        'containerOverrides': {'command': command, 'resourceRequirements': [{'type': 'VCPU', 'value': '4'}, {'type': 'MEMORY', 'value': '8192'}]},
    }]
    assert loads(result.stdout) == {
        'jobId': 'job-id', 'jobDefinition': arn, 'queue': 'ctbk-reproc', 'image': image,
        'months': 2, 'vcpus': 4, 'memory': 8192, 'command': command, 'useExistingJobDefinition': True,
    }


def test_month_counts_and_midnight_carry(tmp_path):
    base = datetime(2025, 6, 1)
    start = int((base - datetime(1970, 1, 1)).total_seconds())
    offsets = [-10, 0, 5, 86395, 20, 30]
    durations = [20, 30, CAP + 1, 10, 0, 20]
    df = pl.DataFrame({
        'Start Time': [base + timedelta(seconds=v) for v in offsets],
        'Stop Time': [base + timedelta(seconds=v + d) for v, d in zip(offsets, durations)],
        'Start Station ID': ['a'] * 6,
        'End Station ID': ['b'] * 5 + ['missing'],
        'Rideable Type': ['classic_bike', 'electric_bike', None, 'classic_bike', None, None],
        'User Type': ['Subscriber', 'Customer', None, 'Subscriber', None, None],
    })
    report = build_month(df, start, start + 2 * 86400, {'a': 'A', 'b': 'B'}, {'A': (40., -74.), 'B': (41., -73.)}, tmp_path)
    assert {k: report[k] for k in ['sourceRides', 'encodedRides', 'invalidDuration', 'unmapped', 'longRides']} == {
        'sourceRides': 5, 'encodedRides': 3, 'invalidDuration': 1, 'unmapped': 1, 'longRides': 1,
    }
    assert {day: (v['rides'], v['carry']) for day, v in report['days'].items()} == {'2025-06-01': (3, 1), '2025-06-02': (0, 1)}
    first = report['days']['2025-06-01']
    assert decode_day(decompress((tmp_path / first['key']).read_bytes())) == (
        2, 1, [Ride(-10, 20, 0, 1, 0), Ride(0, 30, 0, 1, 3), Ride(5, CAP, 0, 1, 28), Ride(86395, 10, 0, 1, 0)],
    )
    assert loads((tmp_path / report['stations']['key']).read_text()) == [{'id': 'A', 'lat': 40., 'lng': -74.}, {'id': 'B', 'lat': 41., 'lng': -73.}]
    repeated = build_month(df.reverse(), start, start + 2 * 86400, {'b': 'B', 'a': 'A'}, {'B': (41., -73.), 'A': (40., -74.)}, tmp_path / 'repeat')
    assert repeated == report
