"""`ctbk gbfs api-check`: contract checks of the live api worker against
real data — goldens for closed rides windows plus invariants that must hold
whatever the data (half-open ranges include their final bin; canonical and
raw station keys sum to the same totals; `/cells` sums to the plain route;
plausible avail/smg shapes). Run daily by `.github/workflows/api-check.yml`.

Goldens (`ctbk/api_check_goldens/<check>.json`) freeze only past-only
windows whose values can't legitimately change except via a deliberate
data repair; after one, regenerate with `-u` and commit the diff (it IS the
repair's footprint). The rides windows are chosen outside the months the
station-id trailing-zero repair touches, and system/bbox totals are
invariant to station re-attribution anyway.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

GOLDENS = Path(__file__).parent / 'api_check_goldens'
NORMALIZED = Path(__file__).parents[1] / 's3' / 'ctbk' / 'normalized'
UA = 'ctbk-api-check/1.0'

SYS_BBOX = '40.5,-74.2,41.0,-73.7'  # NYC + JC + HOB
SMALL_BBOX = '40.70,-74.02,40.73,-73.98'  # lower Manhattan
STATION = '4129.10'  # Herkimer St & Eastern Pkwy (active, unmerged)
STATION_GBFS = 'cf1a96a7-f695-4ba2-bcf2-899552e21e47'


class CheckFailed(Exception):
	pass


@dataclass
class Ctx:
	base: str
	update: bool
	nonce: str
	rides_month: str | None = None

	def get(self, path: str, **params: str) -> dict:
		# `_nc`: every rides/avail response is edge-cached (24h immutable for
		# past windows) under its full URL; a unique param forces a fresh
		# compute, so the check sees what the worker serves now.
		qs = urlencode({**params, '_nc': self.nonce}, safe=',:')
		url = f'{self.base}{path}?{qs}'
		try:
			with urlopen(Request(url, headers={'User-Agent': UA}), timeout=120) as r:
				return json.loads(r.read())
		except HTTPError as e:
			raise CheckFailed(f'HTTP {e.code} for {path}?{qs}: {e.read()[:200]!r}') from None

	def golden(self, name: str, actual: object) -> None:
		path = GOLDENS / f'{name}.json'
		if self.update:
			GOLDENS.mkdir(exist_ok=True)
			path.write_text(json.dumps(actual, indent=1, sort_keys=True) + '\n')
			return
		if not path.exists():
			raise CheckFailed(f'no golden {path.name} (run with -u to create)')
		expected = json.loads(path.read_text())
		if expected != actual:
			raise CheckFailed(f'differs from golden {path.name}: {_diff(expected, actual)}')


def _diff(expected: object, actual: object) -> str:
	if isinstance(expected, dict) and isinstance(actual, dict):
		keys = sorted(set(expected) | set(actual))
		bad = [k for k in keys if expected.get(k) != actual.get(k)]
		shown = ', '.join(f'{k}: {expected.get(k)!r} → {actual.get(k)!r}' for k in bad[:5])
		return f'{len(bad)} key(s) differ ({shown}{", …" if len(bad) > 5 else ""})'
	return f'{expected!r} → {actual!r}'


def _month(dt_ms: int) -> str:
	return datetime.fromtimestamp(dt_ms / 1000, tz=timezone.utc).strftime('%Y-%m')


def _day(dt_ms: int) -> str:
	return datetime.fromtimestamp(dt_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def _months(frm: str, to: str) -> list[str]:
	"""`YYYY-MM` labels of the monthly bins in half-open `[frm, to)`."""
	y, m = int(frm[:4]), int(frm[5:7])
	out = []
	while f'{y:04d}-{m:02d}' < to[:7]:
		out.append(f'{y:04d}-{m:02d}')
		y, m = (y + 1, 1) if m == 12 else (y, m + 1)
	return out


def _totals(records: list[dict], key: Callable[[int], str]) -> dict[str, int]:
	out: dict[str, int] = defaultdict(int)
	for r in records:
		out[key(r['dt'])] += r['count']
	return dict(sorted(out.items()))


def _iso(d: str) -> str:
	return f'{d}T00:00:00Z'


def rides_monthly(anchor: str, frm: str, to: str) -> Callable[[Ctx], str]:
	"""System-bbox monthly rides over a closed `[frm, to)`: every month in
	range is present (final bin included), and per-month totals match the
	golden."""
	def check(c: Ctx) -> str:
		body = c.get('/api/rides', anchor=anchor, bbox=SYS_BBOX, reducer='sum', bin='1mo', **{'from': _iso(frm), 'to': _iso(to)})
		totals = _totals(body['records'], _month)
		expected = _months(frm, to)
		if list(totals) != expected:
			missing = sorted(set(expected) - set(totals))
			extra = sorted(set(totals) - set(expected))
			raise CheckFailed(f'months {missing=} {extra=} (half-open [{frm}, {to}))')
		c.golden(f'rides-{anchor}-{frm[:7]}-{to[:7]}', totals)
		return f'{len(totals)} months, {sum(totals.values()):,} rides'
	return check


def _rides_month_range(month: str | None = None) -> tuple[str, str]:
	"""Latest consolidated month in the checkout, rather than the newer ZIP
	tip or the pyramid's coarsest tip, which can hide incomplete fine tiers."""
	if month is None:
		months = sorted(p.name[:6] for p in NORMALIZED.glob('[0-9]' * 6 + '.parquet.dvc'))
		if not months:
			raise CheckFailed(f'no consolidated months in {NORMALIZED} (use --rides-month)')
		month = months[-1]
	month = month.replace('-', '')
	if len(month) != 6 or not month.isdigit():
		raise CheckFailed(f'rides month must be YYYYMM or YYYY-MM; got {month!r}')
	start = datetime(int(month[:4]), int(month[4:]), 1, tzinfo=timezone.utc)
	end = datetime(start.year + (start.month == 12), start.month % 12 + 1, 1, tzinfo=timezone.utc)
	return _iso(f'{start:%Y-%m-%d}'), _iso(f'{end:%Y-%m-%d}')


def _plan_coverage(body: dict) -> list[tuple[str, str]]:
	"""Union the planner's intervals; empty ride bins do not imply a hole."""
	parse = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
	intervals = sorted((parse(s['from']), parse(s['to'])) for s in body['plan']['segments'])
	merged = []
	for start, end in intervals:
		if end <= start:
			raise CheckFailed(f'invalid plan interval [{start.isoformat()}, {end.isoformat()})')
		if merged and start <= merged[-1][1]:
			merged[-1] = (merged[-1][0], max(merged[-1][1], end))
		else:
			merged.append((start, end))
	return [(s.isoformat().replace('+00:00', 'Z'), e.isoformat().replace('+00:00', 'Z')) for s, e in merged]


def rides_latest_month(anchor: str) -> Callable[[Ctx], str]:
	"""Every served fine tier covers the latest consolidated month and sums
	to its monthly total. A monthly shard alone cannot satisfy this check."""
	def check(c: Ctx) -> str:
		frm, to = _rides_month_range(c.rides_month)
		params = dict(anchor=anchor, cells=f's:{STATION}', reducer='sum', **{'from': frm, 'to': to})
		monthly = c.get('/api/rides', bin='1mo', **params)
		total = sum(r['count'] for r in monthly['records'])
		if total <= 0:
			raise CheckFailed(f'no monthly rides for s:{STATION} in {frm[:7]}')
		for tier in ('1h', '3h', '6h', '12h', '1d'):
			# The worker caps plans at 512 atoms. A full hourly month has
			# 672–744 atoms; two ≤16-day requests stay below that limit.
			if tier == '1h':
				middle = (datetime.fromisoformat(frm.replace('Z', '+00:00')) + timedelta(days=16)).isoformat().replace('+00:00', 'Z')
				windows = [(frm, middle), (middle, to)]
			else:
				windows = [(frm, to)]
			bodies = [c.get('/api/rides', bin=tier, **{**params, 'from': lo, 'to': hi}) for lo, hi in windows]
			coverage = _plan_coverage({'plan': {'segments': [s for body in bodies for s in body['plan']['segments']]}})
			if coverage != [(frm, to)]:
				raise CheckFailed(f'{frm[:7]} {tier} plan covers {coverage!r}; expected {[(frm, to)]!r}')
			fine_total = sum(r['count'] for body in bodies for r in body['records'])
			if fine_total != total:
				raise CheckFailed(f'{frm[:7]} {tier} total {fine_total:,} ≠ monthly {total:,}')
		return f'{frm[:7]}: 5 fine tiers cover full month, {total:,} rides each'
	return check


def rides_station_daily(c: Ctx) -> str:
	"""One unmerged station's daily rides for 2025-03 (golden); `raw=1`
	must equal the canonical view for an unmerged station."""
	params = dict(anchor='start', cells=f's:{STATION}', reducer='sum', bin='1d', **{'from': _iso('2025-03-01'), 'to': _iso('2025-04-01')})
	canon = _totals(c.get('/api/rides', **params)['records'], _day)
	raw = _totals(c.get('/api/rides', raw='1', **params)['records'], _day)
	if canon != raw:
		raise CheckFailed(f'canonical ≠ raw for unmerged s:{STATION}: {_diff(canon, raw)}')
	if max(canon) != '2025-03-31':
		raise CheckFailed(f'last day {max(canon)} ≠ 2025-03-31 (final bin dropped?)')
	c.golden(f'rides-station-{STATION}-2025-03', canon)
	return f'{len(canon)} days, {sum(canon.values()):,} rides'


def rides_canonical_equals_raw(c: Ctx) -> str:
	"""Over a bbox, materialized `c:` rollups + unmerged `s:` rows must sum
	to exactly the raw leaves (`c:` == Σ members, in aggregate)."""
	params = dict(anchor='start', bbox=SYS_BBOX, reducer='sum', bin='1d', **{'from': _iso('2025-03-01'), 'to': _iso('2025-04-01')})
	canon = _totals(c.get('/api/rides', **params)['records'], _day)
	raw = _totals(c.get('/api/rides', raw='1', **params)['records'], _day)
	if canon != raw:
		raise CheckFailed(f'Σ canonical ≠ Σ raw: {_diff(canon, raw)}')
	return f'{len(canon)} days, {sum(canon.values()):,} rides both ways'


def rides_cells_sum(c: Ctx) -> str:
	"""`/api/rides/cells` per-cell rows sum to the plain route's totals."""
	params = dict(anchor='start', bbox=SMALL_BBOX, reducer='sum', bin='1d', **{'from': _iso('2025-03-01'), 'to': _iso('2025-04-01')})
	plain = _totals(c.get('/api/rides', **params)['records'], _day)
	cells_body = c.get('/api/rides/cells', **params)
	cells = _totals(cells_body['records'], _day)
	if plain != cells:
		raise CheckFailed(f'Σ /cells ≠ /api/rides: {_diff(plain, cells)}')
	ncells = len({r['cell'] for r in cells_body['records']})
	return f'{ncells} cells, {sum(cells.values()):,} rides'


AVAIL_METRICS = ('bikes', 'ebikes', 'docks', 'disabled')


def avail_station(pyramid: str | None) -> Callable[[Ctx], str]:
	"""A station's availability over a closed 2-day window: non-empty, bins
	inside the window, values non-negative and bounded."""
	def check(c: Ctx) -> str:
		frm, to = '2026-09-18', '2026-09-20'
		params = dict(cells=f's:{STATION}', bin_budget='48', reducer='mean', **{'from': _iso(frm), 'to': _iso(to)})
		if pyramid:
			params['pyramid'] = pyramid
		recs = c.get('/api/avail-v3', **params)['records']
		if not recs:
			raise CheckFailed('no records')
		lo = datetime.fromisoformat(_iso(frm).replace('Z', '+00:00')).timestamp() * 1000
		hi = datetime.fromisoformat(_iso(to).replace('Z', '+00:00')).timestamp() * 1000
		out = [r['dt'] for r in recs if not lo <= r['dt'] < hi]
		if out:
			raise CheckFailed(f'{len(out)} bin(s) outside [{frm}, {to})')
		bad = [(r['dt'], m, r[m]) for r in recs for m in AVAIL_METRICS if r.get(m) is not None and not 0 <= r[m] <= 200]
		if bad:
			raise CheckFailed(f'implausible values {bad[:3]}')
		return f'{len(recs)} bins'
	return check


def smg_hist(c: Ctx) -> str:
	"""Station-minute state histograms over a closed window: non-empty, every
	histogram's counts non-negative."""
	recs = c.get('/api/avail-v3', pyramid='smg-v1', reducer='hist', bbox='40.5,-74.3,41.0,-73.6', bin_budget='14', **{'from': _iso('2026-09-01'), 'to': _iso('2026-09-15')})['records']
	if not recs:
		raise CheckFailed('no records')
	bad = [r['dt'] for r in recs for h in (r.get('state') or {}, r.get('state_ff') or {}) for v in h.values() if v < 0]
	if bad:
		raise CheckFailed(f'negative histogram counts at {bad[:3]}')
	return f'{len(recs)} records'


def station_info(c: Ctx) -> str:
	"""Stable identity fields of a known station (golden)."""
	body = c.get(f'/api/stations/{STATION_GBFS}/info')
	stable = {k: body.get(k) for k in ('short_name', 'gbfs_station_id', 'name', 'lat', 'lon', 'first_seen')}
	c.golden(f'station-info-{STATION}', stable)
	return stable['name']


def stations_slugs(c: Ctx) -> str:
	"""The slug registry: plausibly complete, unique, non-empty slugs."""
	stations = c.get('/api/stations/slugs')['stations']
	slugs = [s.get('slug') for s in stations]
	empty = [s['short_name'] for s in stations if not s.get('slug')]
	dups = sorted({s for s in slugs if s and slugs.count(s) > 1})
	if len(stations) < 2000 or empty or dups:
		raise CheckFailed(f'{len(stations)} stations, {len(empty)} without slug, dup slugs {dups[:5]}')
	return f'{len(stations)} stations'


def totals_avail(c: Ctx) -> str:
	"""System availability totals over a closed week: non-empty, sampled,
	bins inside the window."""
	frm, to = 1789000000, 1789600000
	rows = c.get('/api/totals', kind='availability', metric='all', scope='all', bin='3600', **{'from': str(frm), 'to': str(to)})['rows']
	if not rows:
		raise CheckFailed('no rows')
	bad = [r['dt'] for r in rows if not (frm * 1000 <= r['dt'] < to * 1000 or frm <= r['dt'] < to) or r.get('sample_count', 0) <= 0]
	if bad:
		raise CheckFailed(f'{len(bad)} row(s) out of window or unsampled, e.g. {bad[:3]}')
	return f'{len(rows)} rows'


CHECKS: dict[str, Callable[[Ctx], str]] = {
	'rides-start-monthly': rides_monthly('start', '2024-01-01', '2025-07-01'),
	'rides-end-monthly': rides_monthly('end', '2021-01-01', '2023-01-01'),
	'rides-start-latest-month': rides_latest_month('start'),
	'rides-end-latest-month': rides_latest_month('end'),
	'rides-station-daily': rides_station_daily,
	'rides-canonical-eq-raw': rides_canonical_equals_raw,
	'rides-cells-sum': rides_cells_sum,
	'avail-default-station': avail_station(None),
	'avail-v6-station': avail_station('avail-v6'),
	'smg-hist': smg_hist,
	'station-info': station_info,
	'stations-slugs': stations_slugs,
	'totals-avail': totals_avail,
}


def run(
	base: str,
	update: bool,
	only: tuple[str, ...],
	rides_month: str | None = None,
) -> list[tuple[str, bool, str]]:
	ctx = Ctx(base=base, update=update, nonce=str(int(datetime.now(timezone.utc).timestamp())), rides_month=rides_month)
	results = []
	for name, check in CHECKS.items():
		if only and not any(k in name for k in only):
			continue
		try:
			results.append((name, True, check(ctx)))
		except CheckFailed as e:
			results.append((name, False, str(e)))
		except Exception as e:  # a crash in a check is a failed check, reported like one
			results.append((name, False, f'{type(e).__name__}: {e}'))
	return results
