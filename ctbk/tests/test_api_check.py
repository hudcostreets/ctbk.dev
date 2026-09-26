from datetime import datetime, timezone

import pytest

from ctbk import api_check
from ctbk.api_check import CheckFailed, Ctx, _months, rides_monthly


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
