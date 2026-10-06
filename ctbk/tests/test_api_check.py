from datetime import datetime, timezone

import pytest

from ctbk import api_check
from ctbk.api_check import CheckFailed, Ctx, _months, _plan_coverage, _rides_month_range, rides_latest_month, rides_monthly


def ms(ym: str) -> int:
	return int(datetime.fromisoformat(f'{ym}-01T00:00:00+00:00').timestamp() * 1000)


class StubCtx(Ctx):
	"""`Ctx` whose `/api/rides` returns one record per given month."""
	def __init__(self, months: list[str], tmp_path, update: bool = False):
		super().__init__(base='stub', update=update, nonce='0')
		self.months = months

	def get(self, path: str, **params: str) -> dict:
		return {'records': [{'dt': ms(m), 'count': 10 + i} for i, m in enumerate(self.months)]}


@pytest.fixture
def goldens(tmp_path, monkeypatch):
	monkeypatch.setattr(api_check, 'GOLDENS', tmp_path)
	return tmp_path


def test_months_half_open():
	assert _months('2024-11-01', '2025-02-01') == ['2024-11', '2024-12', '2025-01']
	assert _months('2025-01-01', '2025-01-01') == []


def test_rides_monthly_passes_and_writes_golden(goldens):
	check = rides_monthly('start', '2024-11-01', '2025-02-01')
	assert check(StubCtx(['2024-11', '2024-12', '2025-01'], goldens, update=True)) == '3 months, 33 rides'
	assert (goldens / 'rides-start-2024-11-2025-02.json').read_text() == '{\n "2024-11": 10,\n "2024-12": 11,\n "2025-01": 12\n}\n'
	assert check(StubCtx(['2024-11', '2024-12', '2025-01'], goldens)) == '3 months, 33 rides'


def test_rides_monthly_catches_dropped_final_bin(goldens):
	check = rides_monthly('start', '2024-11-01', '2025-02-01')
	with pytest.raises(CheckFailed) as e:
		check(StubCtx(['2024-11', '2024-12'], goldens))
	assert str(e.value) == "months missing=['2025-01'] extra=[] (half-open [2024-11-01, 2025-02-01))"


def test_rides_monthly_catches_golden_drift(goldens):
	check = rides_monthly('start', '2024-11-01', '2025-02-01')
	check(StubCtx(['2024-11', '2024-12', '2025-01'], goldens, update=True))
	drifted = StubCtx(['2024-12', '2024-11', '2025-01'], goldens)  # counts permuted across months
	with pytest.raises(CheckFailed) as e:
		check(drifted)
	assert str(e.value) == "differs from golden rides-start-2024-11-2025-02.json: 2 key(s) differ (2024-11: 10 → 11, 2024-12: 11 → 10)"


def test_latest_rides_month_uses_consolidated_files(tmp_path, monkeypatch):
	monkeypatch.setattr(api_check, 'NORMALIZED', tmp_path)
	for name in ('202607.parquet.dvc', '202608.parquet.dvc', '202609.dvc'):
		(tmp_path / name).touch()
	assert _rides_month_range() == ('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')
	assert _rides_month_range('2026-12') == ('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')


def test_latest_rides_month_requires_metadata(tmp_path, monkeypatch):
	monkeypatch.setattr(api_check, 'NORMALIZED', tmp_path)
	with pytest.raises(CheckFailed) as e:
		_rides_month_range()
	assert str(e.value) == f'no consolidated months in {tmp_path} (use --rides-month)'


def test_plan_coverage_unions_overlapping_and_adjacent_intervals():
	assert _plan_coverage({'plan': {'segments': [
		{'from': '2026-08-06T00:00:00.000Z', 'to': '2026-08-10T00:00:00.000Z'},
		{'from': '2026-08-01T00:00:00.000Z', 'to': '2026-08-07T00:00:00.000Z'},
		{'from': '2026-08-10T00:00:00.000Z', 'to': '2026-09-01T00:00:00.000Z'},
	]}}) == [('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')]


class LatestMonthCtx(Ctx):
	def __init__(
		self,
		gap_tier: str | None = None,
		count_tier: str | None = None,
		gap_end: str = '2026-08-07T00:00:00Z',
	) -> None:
		super().__init__(base='stub', update=False, nonce='0', rides_month='202608')
		self.gap_tier = gap_tier
		self.count_tier = count_tier
		self.gap_end = gap_end
		self.calls = []

	def get(self, path: str, **params: str) -> dict:
		self.calls.append((path, params))
		tier = params['bin']
		segments = [{'from': params['from'], 'to': self.gap_end if tier == self.gap_tier else params['to']}]
		# Sparse station records are legitimate: planner intervals measure
		# coverage, while bins with no trips contribute zero implicitly.
		return {
			'records': [{'dt': ms('2026-08'), 'count': 9 if tier == self.count_tier else 10}],
			'plan': {'segments': segments},
		}


@pytest.mark.parametrize('anchor', ['start', 'end'])
def test_latest_month_all_fine_tiers_cover_and_equal_monthly(anchor):
	ctx = LatestMonthCtx()
	assert rides_latest_month(anchor)(ctx) == '2026-08: 5 fine tiers cover full month, 10 rides each'
	assert ctx.calls == [
		('/api/rides', {'bin': tier, 'anchor': anchor, 'cells': f's:{api_check.STATION}', 'reducer': 'sum',
			'from': '2026-08-01T00:00:00Z', 'to': '2026-09-01T00:00:00Z'})
		for tier in ('1mo', '1h', '3h', '6h', '12h', '1d')
	]


@pytest.mark.parametrize('tier', ['1h', '3h', '6h', '12h', '1d'])
def test_latest_month_detects_partial_plan_despite_complete_monthly(tier):
	with pytest.raises(CheckFailed) as e:
		rides_latest_month('start')(LatestMonthCtx(gap_tier=tier))
	assert str(e.value) == f"2026-08 {tier} plan covers [('2026-08-01T00:00:00Z', '2026-08-07T00:00:00Z')]; expected [('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')]"


def test_latest_month_detects_wrong_total_with_complete_plan():
	with pytest.raises(CheckFailed) as e:
		rides_latest_month('end')(LatestMonthCtx(count_tier='1d'))
	assert str(e.value) == '2026-08 1d total 9 ≠ monthly 10'


def test_latest_month_does_not_accept_coverage_beyond_month():
	with pytest.raises(CheckFailed) as e:
		rides_latest_month('start')(LatestMonthCtx(gap_tier='1h', gap_end='2026-09-02T00:00:00Z'))
	assert str(e.value) == "2026-08 1h plan covers [('2026-08-01T00:00:00Z', '2026-09-02T00:00:00Z')]; expected [('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')]"
