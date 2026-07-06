"""`ctbk gbfs …` — operational tooling for the GBFS pipeline.

Subcommands wrap the recurring wrangler-d1-then-parse and cascade-tick-
then-parse patterns that used to live as inline heredocs in each
diagnostic session. See `~/c/hccs/ctbk` audit note (2026-07).

Groups (subcommands add here as they're needed):
- `ctbk gbfs d1 shards` — pyramid_shards summary (tier × shard_dur).
- `ctbk gbfs cascade tick <t>` — trigger dev/prod `/avail3?t=…` and
  tabulate the WriteResult breakdown.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import click
from click import argument, group, option
from urllib import request as _urlrequest
from urllib.error import HTTPError, URLError

from ctbk.cli.base import ctbk

# Repo-root-relative default: wrangler binary lives inside the api worker's
# node_modules. Overridable per-invocation for other bindings (e.g. cascade).
DEFAULT_WRANGLER_CWD = Path(__file__).resolve().parent.parent / 'gbfs' / 'api'
DEFAULT_DB = 'ctbk-gbfs'

# Ladder order for tier sort (finest → coarsest). Matches the avail-v3
# pyramid config; anything unknown sorts last, alphabetically.
TIER_ORDER = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '6h', '12h', '1d', '3d', '7d']

# Duration → minutes for shard_dur ordering within a tier row group.
_UNIT_MIN = {'min': 1, 'h': 60, 'd': 60 * 24, 'mo': 60 * 24 * 30, 'y': 60 * 24 * 365}


def _dur_min(s: str) -> int:
	"""Sort key for shard_dur. `5min`, `1h`, `2d`, `1mo`, `1y`, `120y`."""
	import re
	m = re.match(r'^(\d+)([a-z]+)$', s)
	if not m:
		return 10**9
	n, unit = int(m.group(1)), m.group(2)
	return n * _UNIT_MIN.get(unit, 10**9)


def _tier_key(t: str) -> tuple[int, str]:
	try:
		return (TIER_ORDER.index(t), t)
	except ValueError:
		return (len(TIER_ORDER), t)


def _run_wrangler_d1(sql: str, *, db: str, wrangler_cwd: Path) -> list[dict]:
	"""Shell out to `wrangler d1 execute --remote --json` and return the
	first result set's `results` list. Uses `npx --no-install` so the
	worker's own wrangler pin is used (no global-install drift)."""
	if not wrangler_cwd.is_dir():
		raise click.ClickException(f'wrangler cwd not found: {wrangler_cwd}')
	proc = subprocess.run(
		['npx', '--no-install', 'wrangler', 'd1', 'execute', db, '--remote', '--command', sql, '--json'],
		cwd=str(wrangler_cwd),
		capture_output=True,
		text=True,
	)
	if proc.returncode != 0:
		msg = proc.stderr.strip() or proc.stdout.strip() or '(no output)'
		raise click.ClickException(f'wrangler d1 execute failed (exit {proc.returncode}): {msg}')
	try:
		data = json.loads(proc.stdout)
	except json.JSONDecodeError as e:
		# wrangler occasionally prefixes JSON with a banner; try to skip to the first `[`.
		idx = proc.stdout.find('[')
		if idx < 0:
			raise click.ClickException(f'unparseable wrangler output: {e}\n{proc.stdout[:500]}') from e
		data = json.loads(proc.stdout[idx:])
	return data[0]['results']


@ctbk.group('gbfs', help='GBFS pipeline ops: D1 queries, cascade ticks, R2 checks, health.')
def gbfs() -> None:
	pass


@gbfs.group('d1', help='D1 (SQLite-on-Workers) queries against the ctbk-gbfs database.')
def gbfs_d1() -> None:
	pass


@gbfs_d1.command('shards', help='Tabulate `pyramid_shards` grouped by (tier, shard_dur).')
@option('-p', '--pyramid', default='avail', show_default=True, help='pyramid name column filter.')
@option('-t', '--tier', default=None, help='Restrict to one tier (e.g. `1m`, `6h`).')
@option('-d', '--shard-dur', 'shard_dur', default=None, help='Restrict to one shard_dur (e.g. `12h`, `1d`).')
@option('-s', '--stale-minutes', type=int, default=None, help='Show only rungs whose latest period_start is older than this many minutes.')
@option('-D', '--db', default=DEFAULT_DB, show_default=True, help='D1 database name.')
@option('-C', '--wrangler-cwd', 'wrangler_cwd', default=str(DEFAULT_WRANGLER_CWD), show_default=True, help='Directory containing a `wrangler` binary (in `node_modules/.bin`).')
def gbfs_d1_shards(
	pyramid: str,
	tier: str | None,
	shard_dur: str | None,
	stale_minutes: int | None,
	db: str,
	wrangler_cwd: str,
) -> None:
	conds = [f"pyramid='{pyramid}'"]
	if tier:
		conds.append(f"tier='{tier}'")
	if shard_dur:
		conds.append(f"shard_dur='{shard_dur}'")
	sql = (
		"SELECT tier, shard_dur, COUNT(*) AS n, "
		"MIN(period_start) AS earliest_ms, MAX(period_start) AS latest_ms "
		"FROM pyramid_shards "
		f"WHERE {' AND '.join(conds)} "
		"GROUP BY tier, shard_dur "
		"ORDER BY tier, shard_dur;"
	)
	rows = _run_wrangler_d1(sql, db=db, wrangler_cwd=Path(wrangler_cwd))
	rows.sort(key=lambda r: (_tier_key(r['tier']), _dur_min(r['shard_dur'])))

	now = datetime.now(tz=timezone.utc)
	def _fmt(ms: int | None) -> tuple[str, float | None]:
		if ms is None:
			return '(none)', None
		dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
		age_min = (now - dt).total_seconds() / 60
		return dt.strftime('%Y-%m-%d %H:%M'), age_min

	# Apply staleness filter (post-query so we can compute against `now`).
	if stale_minutes is not None:
		rows = [r for r in rows if r['latest_ms'] is not None and (now - datetime.fromtimestamp(r['latest_ms'] / 1000, tz=timezone.utc)).total_seconds() / 60 > stale_minutes]

	if not rows:
		print('(no rows)')
		return

	print(f'{"tier":>4} {"shard_dur":>10} {"n":>7}  {"earliest":>16}  {"latest":>16}  age')
	for r in rows:
		earliest, _ = _fmt(r['earliest_ms'])
		latest, age = _fmt(r['latest_ms'])
		if age is None:
			age_str = ''
		elif age < 60:
			age_str = f'{age:.0f}m old'
		elif age < 60 * 24:
			age_str = f'{age / 60:.1f}h old'
		else:
			age_str = f'{age / (60 * 24):.1f}d old'
		print(f'{r["tier"]:>4} {r["shard_dur"]:>10} {r["n"]:>7}  {earliest:>16}  {latest:>16}  {age_str}')


# ─── cascade tick ───────────────────────────────────────────────────

# Env → worker URL. Dev is used constantly for smoke tests; prod
# rarely gets curl-triggered but the endpoint exists.
ENV_URLS = {
	'dev':  'https://ctbk-gbfs-cascade-dev.ryan-0dc.workers.dev',
	'prod': 'https://ctbk-gbfs-cascade.ryan-0dc.workers.dev',
}


@gbfs.group('cascade', help='Cascade worker: trigger ticks, inspect writes.')
def gbfs_cascade() -> None:
	pass


@gbfs_cascade.command('tick', help='Trigger `/avail3?t=<t>` on the dev (or prod) cascade worker, tabulate WriteResult per rung.')
@argument('tick_time', metavar='TICK_TIME')
@option('-e', '--env', 'env_name', type=click.Choice(['dev', 'prod']), default='dev', show_default=True)
@option('-t', '--tier', 'tiers', multiple=True, help='Restrict to one or more tiers (repeatable, or comma-separated).')
@option('-d', '--shard-dur', 'shard_durs', multiple=True, help='Restrict to one or more shard_durs (repeatable, or comma-separated).')
@option('-u', '--url', 'base_url', default=None, help='Override the worker URL (default: per --env).')
@option('-w', '--wrote-detail', is_flag=True, help='Show one line per `wrote` rung (default: only status counts).')
@option('-n', '--dry-run', 'dry_run', is_flag=True, help='Compute rungs + HEAD-check keys, but do not write. Useful for measuring what a tick WOULD do.')
def gbfs_cascade_tick(
	tick_time: str,
	env_name: str,
	tiers: tuple[str, ...],
	shard_durs: tuple[str, ...],
	base_url: str | None,
	wrote_detail: bool,
	dry_run: bool,
) -> None:
	secret = os.environ.get('COMPACTOR_SECRET')
	if not secret:
		raise click.ClickException('COMPACTOR_SECRET not set in env (source .envrc or export it).')
	url_base = base_url or ENV_URLS[env_name]
	# Flatten repeated + comma-separated values.
	def _flat(vs: tuple[str, ...]) -> list[str]:
		out: list[str] = []
		for v in vs:
			out.extend(x.strip() for x in v.split(',') if x.strip())
		return out
	params = [f't={tick_time}']
	tier_list = _flat(tiers)
	if tier_list:
		params.append('tiers=' + ','.join(tier_list))
	sd_list = _flat(shard_durs)
	if sd_list:
		params.append('shardDurs=' + ','.join(sd_list))
	if dry_run:
		params.append('dryRun=1')
	url = f'{url_base}/avail3?{"&".join(params)}'
	# Cloudflare edge rejects the default Python-urllib UA with error 1010;
	# a plain browser-ish UA passes.
	req = _urlrequest.Request(url, headers={
		'x-compactor-secret': secret,
		'user-agent': 'ctbk-gbfs-cli/1.0',
	})
	try:
		with _urlrequest.urlopen(req, timeout=180) as resp:
			body = resp.read().decode()
	except HTTPError as e:
		body = e.read().decode(errors='replace')
		raise click.ClickException(f'HTTP {e.code}: {body[:200]}')
	except URLError as e:
		raise click.ClickException(f'network error: {e}')
	# The worker returns either JSON on success or plain text on
	# Cloudflare-edge errors (`error code: 1102` for OOM, etc.).
	try:
		obj = json.loads(body)
	except json.JSONDecodeError:
		raise click.ClickException(f'non-JSON response (worker died?): {body.strip()[:300]}')
	results = obj.get('results', [])
	counts = Counter(r['status'] for r in results)
	total = len(results)
	# Post-Phase-C: report includes `totalMissing` (min-cover gap count)
	# and `stoppedReason` ('time' | 'ops') when the tick bailed early.
	tm = obj.get('totalMissing')
	stopped = obj.get('stoppedReason')
	extra = ''
	if tm is not None and tm > total:
		extra += f'  (missing={tm})'
	if stopped:
		extra += f'  (stopped={stopped})'
	print(f'tick={obj.get("tickTime", tick_time)}  ({env_name})  rungs={total}{extra}')
	# Order: canonical → surprising last.
	preferred_order = ['wrote', 'exists', 'too_large', 'no_inputs', 'empty']
	seen: set[str] = set()
	for k in preferred_order:
		if k in counts:
			print(f'  {k:>10}: {counts[k]}')
			seen.add(k)
	for k in sorted(counts):
		if k not in seen:
			print(f'  {k:>10}: {counts[k]}')
	# Detail rows
	if wrote_detail:
		for r in results:
			if r['status'] == 'wrote':
				parts = r['key'].split('/')
				tag = f'{parts[1]}@{parts[2]}' if len(parts) >= 3 else r['key']
				print(f'  wrote /{tag}  rows={r.get("rows", "?")}  bytes={r.get("bytes", "?")}')
	# Always show too_large + no_inputs details (they're diagnostic-relevant).
	for r in results:
		if r['status'] == 'too_large':
			parts = r['key'].split('/')
			tag = f'{parts[1]}@{parts[2]}' if len(parts) >= 3 else r['key']
			print(f'  too_large /{tag}  est_rows={r.get("estimatedRows", "?")}  inputs={r.get("inputsPresent", "?")}/{r.get("inputsExpected", "?")}')


@gbfs_cascade.command('gc', help='GC sweep: delete registered shards superseded by a min-cover parent past the grace window.')
@option('-t', '--now', 'now_ts', default=None, help='Reference time (ISO); default = wall clock now.')
@option('-e', '--env', 'env_name', type=click.Choice(['dev', 'prod']), default='dev', show_default=True)
@option('-T', '--tier', 'tiers', multiple=True, help='Restrict to a tier (repeatable / comma-separated).')
@option('-g', '--grace-minutes', 'grace_minutes', type=int, default=None, help='Skip shards whose period_end + this > now. Default 15.')
@option('-u', '--url', 'base_url', default=None, help='Override the worker URL.')
@option('-n', '--dry-run', 'dry_run', is_flag=True, help='Report eligible + would-delete, no R2/D1 mutations.')
@option('-d', '--deleted-detail', 'deleted_detail', is_flag=True, help='Print one line per deleted shard.')
def gbfs_cascade_gc(
	now_ts: str | None,
	env_name: str,
	tiers: tuple[str, ...],
	grace_minutes: int | None,
	base_url: str | None,
	dry_run: bool,
	deleted_detail: bool,
) -> None:
	secret = os.environ.get('COMPACTOR_SECRET')
	if not secret:
		raise click.ClickException('COMPACTOR_SECRET not set in env.')
	url_base = base_url or ENV_URLS[env_name]
	def _flat(vs: tuple[str, ...]) -> list[str]:
		out: list[str] = []
		for v in vs:
			out.extend(x.strip() for x in v.split(',') if x.strip())
		return out
	params: list[str] = []
	if now_ts:
		params.append(f't={now_ts}')
	tier_list = _flat(tiers)
	if tier_list:
		params.append('tiers=' + ','.join(tier_list))
	if grace_minutes is not None:
		params.append(f'graceMinutes={grace_minutes}')
	if dry_run:
		params.append('dryRun=1')
	url = f'{url_base}/avail3-gc?{"&".join(params)}' if params else f'{url_base}/avail3-gc'
	req = _urlrequest.Request(url, headers={
		'x-compactor-secret': secret,
		'user-agent': 'ctbk-gbfs-cli/1.0',
	})
	try:
		with _urlrequest.urlopen(req, timeout=180) as resp:
			body = resp.read().decode()
	except HTTPError as e:
		body = e.read().decode(errors='replace')
		raise click.ClickException(f'HTTP {e.code}: {body[:200]}')
	except URLError as e:
		raise click.ClickException(f'network error: {e}')
	try:
		obj = json.loads(body)
	except json.JSONDecodeError:
		raise click.ClickException(f'non-JSON response (worker died?): {body.strip()[:300]}')
	total = obj.get('totalEligible', 0)
	deleted = obj.get('deleted', [])
	skipped = obj.get('skipped', [])
	stopped = obj.get('stoppedReason')
	stats = obj.get('stats', {})
	extra = ''
	if stopped:
		extra += f'  (stopped={stopped})'
	print(f'gc t={obj.get("now")}  ({env_name})  eligible={total}  deleted={len(deleted)}  skipped={len(skipped)}{extra}')
	for k, v in sorted(stats.items()):
		print(f'  {k:>18}: {v}')
	if deleted_detail:
		for d in deleted:
			print(f'  deleted /{d["tier"]}@{d["shardDur"]}  key={d["key"]}')
