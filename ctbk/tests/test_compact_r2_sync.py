from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from subprocess import CompletedProcess

import pytest


def load():
    spec = spec_from_file_location('compact_r2', Path(__file__).parents[2] / 'gbfs' / 'compact-r2.py')
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_aws(module, monkeypatch, returncodes: list[int]) -> list[list[str]]:
    """`aws s3 sync` stub returning `returncodes` in order; records each argv."""
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        return CompletedProcess(argv, returncodes[len(calls) - 1], '', 'AWS_ERROR_HTTP_CHANNEL_THROUGHPUT_FAILURE')
    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setattr(module, 'sleep', lambda s: None)
    return calls


def test_sync_retries_transient_failures(tmp_path: Path, monkeypatch):
    # 2026-11-18: 15 of the day's WAL GETs hit R2 throughput timeouts and the
    # whole compaction failed. `sync` only fetches what's still missing, so
    # rerunning it is the retry.
    module = load()
    calls = fake_aws(module, monkeypatch, [1, 1, 0])
    module.s3_sync('s3://ctbk/gbfs/status/2026-11-17/', tmp_path)
    assert calls == [['aws', 's3', 'sync', 's3://ctbk/gbfs/status/2026-11-17/', str(tmp_path), '--exclude', '*', '--include', '*.json', *module.AWS_PROFILE_ARGS]] * 3


def test_sync_gives_up_after_attempts(tmp_path: Path, monkeypatch):
    module = load()
    calls = fake_aws(module, monkeypatch, [1, 1, 1])
    with pytest.raises(SystemExit) as exc:
        module.s3_sync('s3://ctbk/gbfs/status/2026-11-17/', tmp_path)
    assert (exc.value.code, len(calls)) == (1, 3)
