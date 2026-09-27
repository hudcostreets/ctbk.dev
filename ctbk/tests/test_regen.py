"""`ctbk regen` job construction + `batch/regen-targets` scoping
(specs/batch-pipeline.md)."""
import subprocess
from os.path import dirname, join

from ctbk.regen import job_command, job_env

ROOT = join(dirname(__file__), '..', '..')


def regen_targets(*args: str) -> list[str]:
    return subprocess.run(
        [join(ROOT, 'batch', 'regen-targets'), *args],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()


def test_job_env_partial_regen():
    assert job_env('201306,201507-201912', ('cons', 'smh-in'), pin_upstream=True, results_prefix='regen-results') == {
        'RESULTS_PREFIX': 'regen-results',
        'REGEN_TARGETS': '-m 201306,201507-201912 -f cons -f smh-in',
        'DVX_CACHED': 's3/ctbk/normalized/?????? s3/ctbk/normalized/v0/*',
    }


def test_job_env_chained_script():
    assert job_env(None, (), pin_upstream=False, results_prefix='regen-results', base_ref='regen-results/20260927-120000') == {
        'RESULTS_PREFIX': 'regen-results',
        'BASE_REF': 'regen-results/20260927-120000',
    }


def test_job_env_full_unpinned():
    assert job_env(None, (), pin_upstream=False, results_prefix='reproc-results') == {
        'RESULTS_PREFIX': 'reproc-results',
    }


def test_job_command_dvx_run():
    assert job_command(None, force=True, jobs=16) == [
        'run', '--no-commit', '--push', 'each', '--remote', 'r2', '--force', '-j', '16', '-v',
    ]


def test_job_command_script():
    assert job_command('ctbk station-harmonize create -f', force=True, jobs=None) == [
        'script', 'ctbk station-harmonize create -f',
    ]


def test_regen_targets_one_month_default_families():
    # Default families exclude `norm`/`v0` (a regen re-derives from pinned norm
    # outputs).
    assert sorted(regen_targets('-m', '201801')) == [
        's3/ctbk/aggregated/201801/se_c.json.dvc',
        's3/ctbk/aggregated/201801/stations.json.dvc',
        's3/ctbk/aggregated/e_c_201801.parquet.dvc',
        's3/ctbk/aggregated/se_c_201801.parquet.dvc',
        's3/ctbk/aggregated/ymrgtb_cd_201801.parquet.dvc',
        's3/ctbk/aggregated/ymrgtbe_cd_201801.parquet.dvc',
        's3/ctbk/aggregated/ymrgtbs_cd_201801.parquet.dvc',
        's3/ctbk/normalized/201801.parquet.dvc',
        's3/ctbk/stations/meta_hists/il_201801.parquet.dvc',
        's3/ctbk/stations/meta_hists/in_201801.parquet.dvc',
    ]


def test_regen_targets_ranges_and_families():
    assert regen_targets('-m', '201911-202002', '-f', 'cons') == [
        's3/ctbk/normalized/201911.parquet.dvc',
        's3/ctbk/normalized/201912.parquet.dvc',
        's3/ctbk/normalized/202001.parquet.dvc',
        's3/ctbk/normalized/202002.parquet.dvc',
    ]
