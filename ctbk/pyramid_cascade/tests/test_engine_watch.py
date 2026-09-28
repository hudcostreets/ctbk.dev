"""`ctbk gbfs engine watch`: polls Batch until no job is live, exits 1 on a
failure, 2 on timeout (boto3 stubbed; no network)."""
from __future__ import annotations

from unittest.mock import patch

from click.testing import CliRunner

from ctbk.gbfs_cli import gbfs_engine_watch


class FakeBatch:
    """`describe_jobs` returns the next scripted status per job on each call."""
    def __init__(self, script: dict[str, list[str]]):
        self.script = script
        self.calls = 0

    def describe_jobs(self, jobs: list[str]) -> dict:
        i = self.calls
        self.calls += 1
        return {'jobs': [
            {'jobId': j, 'jobName': f'{j}-build', 'status': self.script[j][min(i, len(self.script[j]) - 1)], 'statusReason': 'why'}
            for j in jobs
        ]}


def run(script: dict[str, list[str]], *args: str):
    fake = FakeBatch(script)
    logged: list[str] = []
    # `err` is bound to the real stderr at import, so capture it directly.
    with patch('boto3.client', return_value=fake), patch('time.sleep'), patch('ctbk.gbfs_cli.err', logged.append):
        result = CliRunner().invoke(gbfs_engine_watch, ['-i', '0', *args, *script])
    lines = [line.split(' ', 1)[1] if line[:2].isdigit() else line for line in logged]  # drop the HH:MM:SS
    return result.exit_code, lines, fake.calls


def test_polls_until_all_terminal():
    code, lines, calls = run({'a': ['RUNNING', 'SUCCEEDED'], 'b': ['RUNNABLE', 'RUNNING', 'SUCCEEDED']})
    assert (code, calls) == (0, 3)
    assert lines == [
        'a-build RUNNING · b-build RUNNABLE',
        'a-build SUCCEEDED · b-build RUNNING',
        'a-build SUCCEEDED · b-build SUCCEEDED',
    ]


def test_failure_exits_1():
    code, lines, _ = run({'a': ['FAILED'], 'b': ['SUCCEEDED']})
    assert code == 1
    assert lines == ['a-build FAILED · b-build SUCCEEDED', 'a-build: FAILED — why']


def test_timeout_exits_2():
    code, lines, _ = run({'a': ['RUNNING']}, '-t', '0')
    assert (code, lines) == (2, ['a-build RUNNING', 'timeout'])
