"""Tests for the per-config Batch shard sort (`ctbk gbfs engine submit
-s`) and the rides config-name predicates (`specs/rides-v5.md`,
`specs/timelapse-map.md`)."""
from __future__ import annotations

import pytest

from ctbk.gbfs_cli import RIDES_ANCHOR_SPECS, RIDES_TL_ANCHOR_SPECS, _engine_sort
from ctbk.pyramid_cascade.engine_check import _rides_anchor, _rides_tl, config_rg_size, engine_sort_cols


@pytest.mark.parametrize('config_name, expected', [
    ('rides-tl-start', 'dt,cell'),
    ('rides-tl-end', 'dt,cell'),
    ('rides-start', 'cell,dt,gender,user_type,bike_type'),
    ('rides-end', 'cell,dt,gender,user_type,bike_type'),
    ('avail-v6', 's2_cell,dt'),
    ('smg-v1', 's2_cell,dt'),
])
def test_engine_sort(config_name: str, expected: str):
    assert _engine_sort(config_name) == expected
    assert engine_sort_cols(config_name) == expected.split(',')


@pytest.mark.parametrize('config_name, anchor, tl', [
    ('rides-start', 'start', False),
    ('rides-end', 'end', False),
    ('rides-tl-start', 'start', True),
    ('rides-tl-end', 'end', True),
    ('avail-v6', None, False),
    ('rides-tl-start-engine-check', None, False),
])
def test_rides_predicates(config_name: str, anchor: str | None, tl: bool):
    assert _rides_anchor(config_name) == anchor
    assert _rides_tl(config_name) is tl


def test_anchor_spec_tables():
    assert RIDES_ANCHOR_SPECS == (
        ('rides-start', 'rides/start', 'ctbk_engine_src:rides_start'),
        ('rides-end', 'rides/end', 'ctbk_engine_src:rides_end'),
    )
    assert RIDES_TL_ANCHOR_SPECS == (
        ('rides-tl-start', 'rides-tl/start', 'ctbk_engine_src:rides_tl_start'),
        ('rides-tl-end', 'rides-tl/end', 'ctbk_engine_src:rides_tl_end'),
    )


@pytest.mark.parametrize('config_name, prefix, factory, sort, rg', [
    ('rides-start', 'rides/start', 'rides_start', 'cell,dt,gender,user_type,bike_type', 2048),
    ('rides-tl-start', 'rides-tl/start', 'rides_tl_start', 'dt,cell', 32768),
    ('rides-tl-end', 'rides-tl/end', 'rides_tl_end', 'dt,cell', 32768),
])
def test_engine_submit_real_prefix_dry_run(config_name: str, prefix: str, factory: str, sort: str, rg: int):
    # `engine submit -R` derives the prefix from the config's keyTemplate
    # and, for rides configs, the source factory from the spec tables —
    # the `rides-tl-*` transposes must get `rides_tl_*`, not the `rides_*`
    # factory their anchor alone would name.
    from click.testing import CliRunner
    from ctbk.gbfs_cli import gbfs_engine
    result = CliRunner().invoke(
        gbfs_engine, ['submit', '-C', config_name, '-R', '-r', '2025-06-01/2025-07-01', '-n'],
        env={'R2_BUCKET': 'ctbk'},
    )
    assert result.exit_code == 0, result.output
    assert result.output.rstrip('\n').split('\n') == [
        f'pyrmts-engine batch submit -n {prefix.replace("/", "-")} -w 12h -g {rg} -s {sort} '
        f'-m s3://ctbk/{prefix}/manifest.jsonl -r 2025-06-01T00:00/2025-07-01T00:00 '
        f'-x ctbk_engine_src:{factory} s3://ctbk/{prefix}/config.yaml',
    ]


def test_rides_tl_extend_dry_run(monkeypatch: pytest.MonkeyPatch):
    # The monthly `rides-tl` step: fill both time-first anchors at their real
    # prefixes, capped at the first of the month after YM (never "now": the
    # cap keeps the tip closed), then watch both jobs. Wired into CI after
    # `rides-extend` (`.github/workflows/ci.yml` "Extend rides-tl").
    from click.testing import CliRunner
    from ctbk import gbfs_cli
    # `utz.err` holds the stderr object it was imported with, so neither
    # CliRunner nor capsys sees its output; collect the log lines directly.
    logged: list[str] = []
    monkeypatch.setattr(gbfs_cli, 'err', lambda *a: logged.append(' '.join(map(str, a))))
    result = CliRunner().invoke(gbfs_cli.gbfs, ['rides-tl-extend', '-n', '2025-06'], env={'R2_BUCKET': 'ctbk'})
    assert result.exit_code == 0, result.output
    assert result.stdout.rstrip('\n').split('\n') == [
        f'pyrmts-engine batch submit -n rides-tl-{a} -w 12h -g 32768 -s dt,cell '
        f'-m s3://ctbk/rides-tl/{a}/manifest.jsonl -r 2013-06-01T00:00/2025-07-01T00:00 -f '
        f'-x ctbk_engine_src:rides_tl_{a} s3://ctbk/rides-tl/{a}/config.yaml'
        for a in ('start', 'end')
    ]
    assert logged == ['watch: would poll both jobs to completion (`ctbk gbfs engine watch`)']


@pytest.mark.parametrize('config_name, expected', [
    ('rides-tl-start', 32768),
    ('rides-tl-end', 32768),
    ('rides-start', 2048),
    ('smg-v1', 2048),
])
def test_config_rg_size(config_name: str, expected: int):
    assert config_rg_size(config_name) == expected
