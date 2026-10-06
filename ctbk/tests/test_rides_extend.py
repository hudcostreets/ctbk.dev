from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from ctbk import gbfs_cli
from ctbk.pyramid_cascade import engine_check
from pyrmts_engine import invalidation


@pytest.mark.parametrize('ym, previous, month, cutoff', [
	('202608', '2026-07-01', '2026-08-01', '2026-09-01'),
	('202612', '2026-11-01', '2026-12-01', '2027-01-01'),
	('202701', '2026-12-01', '2027-01-01', '2027-02-01'),
])
def test_rides_extend_caps_fill_at_published_month(
	monkeypatch: pytest.MonkeyPatch,
	ym: str,
	previous: str,
	month: str,
	cutoff: str,
) -> None:
	# An uncapped min-cover shard can span published August and unpublished
	# September. Deferring that shard leaves August uncovered at fine tiers.
	# Exercise the driver without a source download, cloud write or Batch job.
	calls = []
	parse = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
	monkeypatch.setattr(gbfs_cli, '_use_r2_rw_env', lambda: None)
	monkeypatch.setattr(gbfs_cli, '_r2_client', lambda rw: ('r2', 'ctbk'))
	monkeypatch.setattr(gbfs_cli, '_mirror_normalized', lambda *args: calls.append(('mirror', args)))
	monkeypatch.setattr(engine_check, 'load_pyramid', lambda name: name)
	monkeypatch.setattr(invalidation, 'load_invalidations', lambda pyramid: ([SimpleNamespace(start=parse(previous), end=parse(month))], None))
	monkeypatch.setattr(gbfs_cli, '_engine_submit', lambda config, **kwargs: calls.append(('submit', config, kwargs)) or 0)
	monkeypatch.setattr(gbfs_cli, 'err', lambda *args: None)
	for name, command in (
		('canonicalize', gbfs_cli.gbfs_engine_canonicalize),
		('register', gbfs_cli.gbfs_engine_register),
		('backfill', gbfs_cli.gbfs_manifest_backfill),
		('prune', gbfs_cli.gbfs_manifest_prune),
	):
		monkeypatch.setattr(command, 'callback', lambda name=name, **kwargs: calls.append((name, kwargs)))
	result = CliRunner().invoke(gbfs_cli.gbfs, ['rides-extend', '-n', ym])
	assert result.exit_code == 0, result.output
	assert calls[:3] == [
		('mirror', ('r2', 'ctbk', ym, True)),
		('submit', 'rides-start', {
			'scratch_prefix': 'rides/start', 'fill': True,
			'range_': f'2013-06-01/{cutoff}',
			'source_spec': 'ctbk_engine_src:rides_start', 'watch': True, 'dry_run': True,
		}),
		('submit', 'rides-end', {
			'scratch_prefix': 'rides/end', 'fill': True,
			'range_': f'2013-06-01/{cutoff}',
			'source_spec': 'ctbk_engine_src:rides_end', 'watch': True, 'dry_run': True,
		}),
	]
	assert calls[3:5] == [
		('canonicalize', {'config_name': anchor, 'range_': f'{previous}T00:00/{cutoff}T00:00', 'workers': 4, 'dry_run': True,
			'rg_size': None, 'manifest_name': 'manifest.jsonl', 'map_path': 's3/ctbk/stations/station-canonicalize-map.json'})
		for anchor in ('rides-start', 'rides-end')
	]
	assert calls[5:] == [
		('backfill', {'pyramids': ('rides-start', 'rides-end'), 'env_name': 'prod', 'dry_run': True, 'min_bins': 450, 'max_keys': None}),
		('prune', {'pyramids': ('rides-start', 'rides-end'), 'env_name': 'prod', 'dry_run': True, 'd1_rest': False}),
	]


def test_capped_hourly_cover_keeps_published_august_shards_closed() -> None:
	from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config
	from pyrmts_engine import compile_plan
	config = Path(__file__).parents[2] / 'configs' / 'pyramids' / 'rides-start.yaml'
	pyramid = pyramid_from_config(parse_pyramid_yaml(config.read_text()), MemStorage())
	parse = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
	def august_tip(cutoff: str) -> list[tuple[str, str, str]]:
		plan = compile_plan(pyramid, (parse('2013-06-01'), parse(cutoff)))
		return [(e.shard_dur, e.effective_start.strftime('%Y-%m-%d'), e.effective_end.strftime('%Y-%m-%d'))
			for e in plan.outputs if e.tier == '1h' and e.effective_start >= parse('2026-08-01')]
	assert august_tip('2026-09-01') == [
		('16d', '2026-08-07', '2026-08-23'),
		('8d', '2026-08-23', '2026-08-31'),
		('1d', '2026-08-31', '2026-09-01'),
	]
	assert august_tip('2026-09-25') == [
		('32d', '2026-08-07', '2026-09-08'),
		('16d', '2026-09-08', '2026-09-24'),
		('1d', '2026-09-24', '2026-09-25'),
	]
