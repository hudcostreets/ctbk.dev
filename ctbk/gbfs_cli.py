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
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import click
from click import argument, group, option
from utz import err
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


# ─── RG manifest (specs/rg-manifest.md) ─────────────────────────────

MANIFEST_PYRAMIDS = ('rides-v5-start', 'rides-v5-end')


def _registry_post(env_name: str, body: dict) -> dict:
	"""POST a registry-proxy op to the api worker (Bearer
	`CTBK_REGISTRY_SECRET`). All D1 access happens worker-side via the
	binding — the truthful side of the 2026-07-28 REST split-brain."""
	import urllib.request
	secret = os.environ.get('CTBK_REGISTRY_SECRET')
	if not secret:
		raise click.ClickException('CTBK_REGISTRY_SECRET not set. `source .envrc`.')
	from urllib.error import HTTPError
	last: Exception | None = None
	# CF edge occasionally 403s bursty urllib POST loops (bot scoring) —
	# observed on the first backfill run; EB-retry through it.
	for attempt in range(4):
		if attempt:
			time.sleep(2 ** attempt)
		req = urllib.request.Request(
			f'{API_URLS[env_name]}/api/registry',
			data=json.dumps(body).encode(),
			headers={
				'Authorization': f'Bearer {secret}',
				'Content-Type': 'application/json',
				'User-Agent': 'ctbk-gbfs-cli/1.0',
			},
		)
		try:
			with urllib.request.urlopen(req, timeout=120) as resp:
				return json.loads(resp.read())
		except HTTPError as e:
			if e.code not in (403, 429, 500, 502, 503):
				raise
			last = e
			err(f'  registry {body.get("op")}: HTTP {e.code}, retrying ({attempt + 1}/4)')
		except (ConnectionResetError, TimeoutError, OSError) as e:
			# Long sequential loops occasionally get connection resets
			# (each urllib call opens a fresh connection; CF edge churn).
			last = e
			err(f'  registry {body.get("op")}: {type(e).__name__}, retrying ({attempt + 1}/4)')
	raise click.ClickException(f'registry {body.get("op")}: {last}')


@gbfs.group('manifest', help='RG manifest: D1 row-group index for parquet pyramid serving (`specs/rg-manifest.md`).')
def gbfs_manifest() -> None:
	pass


@gbfs_manifest.command('status', help='Fill coverage per pyramid: registered keys vs completed fills (+ stale fills whose shard was re-registered).')
@option('-e', '--env', 'env_name', type=click.Choice(['dev', 'prod']), default='prod', show_default=True, help='api worker to query (shared D1, but ops must be deployed there).')
@option('-p', '--pyramid', 'pyramids', multiple=True, help=f'Pyramid name (repeatable) [default: {", ".join(MANIFEST_PYRAMIDS)}].')
@option('-v', '--verbose', is_flag=True, help='List unfilled/stale keys.')
def gbfs_manifest_status(env_name: str, pyramids: tuple[str, ...], verbose: bool) -> None:
	for pyramid in pyramids or MANIFEST_PYRAMIDS:
		s = _registry_post(env_name, {'op': 'manifest_status', 'pyramid': pyramid})
		print(f'{pyramid}: {s["filled"]}/{s["registered"]} filled, {len(s["stale"])} stale, {len(s["unfilled"])} unfilled')
		if verbose:
			for k in s['stale']:
				print(f'  stale: {k}')
			for k in s['unfilled']:
				print(f'  unfilled: {k}')


@gbfs_manifest.command('backfill', help='Fill manifest rows for unfilled/stale shards (worker parses each footer server-side via `manifest_fill`; sequential, idempotent).')
@option('-e', '--env', 'env_name', type=click.Choice(['dev', 'prod']), default='prod', show_default=True, help='api worker to run fills on.')
@option('-m', '--max', 'max_keys', type=int, default=None, help='Stop after this many fills.')
@option('-n', '--dry-run', is_flag=True, help='List keys that would fill; no writes.')
@option('-p', '--pyramid', 'pyramids', multiple=True, help=f'Pyramid name (repeatable) [default: {", ".join(MANIFEST_PYRAMIDS)}].')
def gbfs_manifest_backfill(env_name: str, max_keys: int | None, dry_run: bool, pyramids: tuple[str, ...]) -> None:
	done = 0
	for pyramid in pyramids or MANIFEST_PYRAMIDS:
		s = _registry_post(env_name, {'op': 'manifest_status', 'pyramid': pyramid})
		todo = s['unfilled'] + s['stale']
		err(f'{pyramid}: {len(todo)} to fill ({len(s["unfilled"])} unfilled, {len(s["stale"])} stale)')
		for key in todo:
			if max_keys is not None and done >= max_keys:
				err(f'stopping at --max {max_keys}')
				return
			if dry_run:
				print(key)
				continue
			t0 = time.time()
			res = _registry_post(env_name, {'op': 'manifest_fill', 'pyramid': pyramid, 'key': key})
			done += 1
			err(f'  filled {key}: {res["n_rgs"]} RGs in {time.time() - t0:.1f}s')
	if not dry_run:
		err(f'{done} fills')


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
@option('-l', '--list-all', 'list_all', is_flag=True, help='Show every result line-by-line (status, key, inputs). Supersedes -w.')
@option('-w', '--wrote-detail', is_flag=True, help='Show one line per `wrote` rung (default: only status counts).')
@option('-n', '--dry-run', 'dry_run', is_flag=True, help='Compute rungs + HEAD-check keys, but do not write. Useful for measuring what a tick WOULD do.')
def gbfs_cascade_tick(
	tick_time: str,
	env_name: str,
	tiers: tuple[str, ...],
	shard_durs: tuple[str, ...],
	base_url: str | None,
	list_all: bool,
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
	def _tag(r: dict) -> str:
		parts = r['key'].split('/')
		return f'{parts[1]}@{parts[2]}/{parts[3].removesuffix(".parquet")}' if len(parts) >= 4 else r['key']
	if list_all:
		# Show every result with inputs + payload (rows/bytes on `wrote`,
		# est on `too_large`, plain for `exists`/`no_inputs`/`empty`).
		for r in results:
			extras = []
			if r.get('inputsPresent') is not None or r.get('inputsExpected') is not None:
				extras.append(f"inputs={r.get('inputsPresent', '?')}/{r.get('inputsExpected', '?')}")
			if r.get('rows') is not None:
				extras.append(f"rows={r['rows']}")
			if r.get('bytes') is not None:
				extras.append(f"bytes={r['bytes']}")
			if r.get('estimatedRows') is not None:
				extras.append(f"est={r['estimatedRows']}")
			suffix = ('  ' + ' '.join(extras)) if extras else ''
			print(f"  {r['status']:>10} /{_tag(r)}{suffix}")
	else:
		if wrote_detail:
			for r in results:
				if r['status'] == 'wrote':
					print(f'  wrote /{_tag(r)}  rows={r.get("rows", "?")}  bytes={r.get("bytes", "?")}')
		# Always show too_large + no_inputs details (diagnostic-relevant).
		for r in results:
			if r['status'] == 'too_large':
				print(f'  too_large /{_tag(r)}  est={r.get("estimatedRows", "?")}  inputs={r.get("inputsPresent", "?")}/{r.get("inputsExpected", "?")}')


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


# ─── R2 subgroup ────────────────────────────────────────────────────────
#
# Wraps the recurring `aws s3 ls --endpoint-url https://<acct>.r2...`
# pattern with .envrc-sourced creds. Avoids re-typing the AWS env vars
# and endpoint construction every time we poke at R2 during cascade
# debugging. Uses boto3 directly rather than shelling to `aws` so we can
# format / filter output without spawning a subprocess per call.


@gbfs.group('r2', help='R2 (S3-compat) queries against the ctbk bucket.')
def gbfs_r2() -> None:
	pass


def _r2_client() -> tuple[object, str]:
	"""Build a boto3 S3 client pointed at the ctbk R2 endpoint. Reads
	`CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
	from the environment (typically sourced from `.envrc`). Returns
	(client, bucket_name)."""
	try:
		import boto3  # type: ignore[import-untyped]
	except ImportError as e:
		raise click.ClickException('boto3 not installed. `uv sync` or `pip install boto3`.') from e
	acct = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
	akid = os.environ.get('R2_ACCESS_KEY_ID')
	sk = os.environ.get('R2_SECRET_ACCESS_KEY')
	if not (acct and akid and sk):
		raise click.ClickException('CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set. `source .envrc`.')
	bucket = os.environ.get('R2_BUCKET', 'ctbk')
	client = boto3.client(
		's3',
		endpoint_url=f'https://{acct}.r2.cloudflarestorage.com',
		aws_access_key_id=akid,
		aws_secret_access_key=sk,
		region_name='auto',
	)
	return client, bucket


@gbfs_r2.command('ls', help='List R2 keys under a prefix (default bucket: ctbk).')
@argument('prefix', metavar='PREFIX')
@option('-n', '--max', 'max_keys', type=int, default=1000, show_default=True, help='Max keys to return.')
@option('-c', '--count', 'count_only', is_flag=True, help='Print only the count, not each key.')
@option('-s', '--size', 'show_size', is_flag=True, help='Print size (bytes) alongside each key.')
@option('-g', '--grep', 'grep_pat', default=None, help='Filter keys by substring (client-side after fetch).')
def gbfs_r2_ls(
	prefix: str,
	max_keys: int,
	count_only: bool,
	show_size: bool,
	grep_pat: str | None,
) -> None:
	client, bucket = _r2_client()
	keys: list[tuple[str, int]] = []
	paginator = client.get_paginator('list_objects_v2')  # type: ignore[attr-defined]
	for page in paginator.paginate(Bucket=bucket, Prefix=prefix, PaginationConfig={'MaxItems': max_keys}):
		for c in page.get('Contents') or []:
			k = c['Key']
			if grep_pat and grep_pat not in k:
				continue
			keys.append((k, int(c.get('Size', 0))))
	if count_only:
		print(len(keys))
		return
	for k, sz in keys:
		print(f'{sz:>12}  {k}' if show_size else k)


@gbfs_r2.command('cp', help='Server-side copy KEY to DEST key (same bucket). With -r, KEY/DEST are prefixes: copy every key under KEY to the same suffix under DEST.')
@option('-f', '--force', is_flag=True, help='Overwrite DEST if it already exists.')
@option('-j', '--jobs', type=int, default=16, show_default=True, help='Concurrent copies (recursive mode).')
@option('-n', '--dry-run', is_flag=True, help='List planned copies without executing (recursive mode).')
@option('-r', '--recursive', is_flag=True, help='Prefix mode: copy all keys under KEY prefix to DEST prefix.')
@argument('key', metavar='KEY')
@argument('dest', metavar='DEST')
def gbfs_r2_cp(
	force: bool,
	jobs: int,
	dry_run: bool,
	recursive: bool,
	key: str,
	dest: str,
) -> None:
	client, bucket = _r2_client()
	if not recursive:
		if not force:
			try:
				client.head_object(Bucket=bucket, Key=dest)  # type: ignore[attr-defined]
				raise click.ClickException(f'{dest} exists (use -f to overwrite)')
			except client.exceptions.ClientError:  # type: ignore[attr-defined]
				pass
		client.copy_object(Bucket=bucket, Key=dest, CopySource={'Bucket': bucket, 'Key': key})  # type: ignore[attr-defined]
		err(f'{key} → {dest}')
		return
	from concurrent.futures import ThreadPoolExecutor
	src_pfx, dst_pfx = key.rstrip('/') + '/', dest.rstrip('/') + '/'
	paginator = client.get_paginator('list_objects_v2')  # type: ignore[attr-defined]
	def list_keys(pfx: str) -> set[str]:
		return {
			c['Key']
			for page in paginator.paginate(Bucket=bucket, Prefix=pfx)
			for c in page.get('Contents') or []
		}
	src_keys = sorted(list_keys(src_pfx))
	if not src_keys:
		raise click.ClickException(f'no keys under {src_pfx}')
	existing = set() if force else list_keys(dst_pfx)
	plan = [
		(k, dst_pfx + k[len(src_pfx):])
		for k in src_keys
		if force or dst_pfx + k[len(src_pfx):] not in existing
	]
	skipped = len(src_keys) - len(plan)
	if dry_run:
		for s, d in plan[:20]:
			err(f'  {s} → {d}')
		err(f'would copy {len(plan)} keys ({skipped} already exist)')
		return
	def cp(pair: tuple[str, str]) -> None:
		s, d = pair
		client.copy_object(Bucket=bucket, Key=d, CopySource={'Bucket': bucket, 'Key': s})  # type: ignore[attr-defined]
	with ThreadPoolExecutor(max_workers=jobs) as pool:
		for _ in pool.map(cp, plan):
			pass
	err(f'copied {len(plan)} keys {src_pfx} → {dst_pfx} ({skipped} already existed)')


@gbfs_r2.command('put', help='Upload a local file to an R2 key.')
@option('-t', '--content-type', default='application/json', show_default=True, help='Content-Type for the uploaded object.')
@argument('src', metavar='SRC', type=click.Path(exists=True, dir_okay=False))
@argument('key', metavar='KEY')
def gbfs_r2_put(content_type: str, src: str, key: str) -> None:
	client, bucket = _r2_client()
	body = Path(src).read_bytes()
	client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)  # type: ignore[attr-defined]
	err(f'{src} → r2://{bucket}/{key} ({len(body):,} B)')


@gbfs_r2.command('rm', help='Delete R2 keys (exact keys, no globbing).')
@argument('keys', metavar='KEY...', nargs=-1, required=True)
def gbfs_r2_rm(keys: tuple[str, ...]) -> None:
	client, bucket = _r2_client()
	for key in keys:
		client.head_object(Bucket=bucket, Key=key)  # type: ignore[attr-defined]  # raise if absent
		client.delete_object(Bucket=bucket, Key=key)  # type: ignore[attr-defined]
		err(f'deleted {key}')


# ─── Station-cell vocabulary (specs/drop-luc-station-keys.md) ───────────

@gbfs.group('vocab', help='Frozen ragged station-cell vocabulary for the v4 pyramids.')
def gbfs_vocab() -> None:
	pass


@gbfs_vocab.command('gen', help='Generate `configs/pyramids/station-vocab.json` from the station registry (R2 denorm by default).')
@option('-o', '--out', default=None, help='Output path [default: configs/pyramids/station-vocab.json].')
@option('-r', '--registry', default=None, help='Local registry json (by_short_name -> {lat, lng}); default fetches `station-luc.json` from R2.')
@option('-T', '--threshold', type=int, default=4, show_default=True, help='Descend while a cell holds more than this many stations.')
def gbfs_vocab_gen(out: str | None, registry: str | None, threshold: int) -> None:
	from ctbk.pyramid_cascade.vocab import build_vocab, dump_vocab
	if registry:
		data = json.loads(Path(registry).read_text())
	else:
		client, bucket = _r2_client()
		obj = client.get_object(Bucket=bucket, Key='station-luc.json')  # type: ignore[attr-defined]
		data = json.loads(obj['Body'].read())
	stations = {sn: (e['lat'], e['lng']) for sn, e in data['by_short_name'].items()}
	vocab = build_vocab(stations, threshold)
	out_path = Path(out) if out else Path(__file__).parents[1] / 'configs/pyramids/station-vocab.json'
	out_path.write_text(dump_vocab(vocab, threshold, len(stations)))
	err(f'{len(vocab)} vocab cells (T={threshold}, {len(stations)} stations) → {out_path}')


# ─── Lambda executor (specs/avail-v3-lambda-cascade.md) ────────────────

LAMBDA_FUNC = 'ctbk-avail-cascade'


@gbfs.group('lambda', help='avail-v3 heavy-rung Lambda executor (`ctbk-avail-cascade`).')
def gbfs_lambda() -> None:
	pass


@gbfs_lambda.command('fill', help='Run the heavy-rung fill locally (same code path as the Lambda handler).')
@option('-C', '--config', 'config_name', default='avail', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-L', '--limit', type=int, default=None, help='Stop after this many gaps.')
@option('-n', '--dry-run', is_flag=True, help='Discover + list gaps, write nothing.')
@option('-R', '--no-register', is_flag=True, help='Skip D1 registration of written shards.')
def gbfs_lambda_fill(config_name: str, limit: int | None, dry_run: bool, no_register: bool) -> None:
	from ctbk.pyramid_cascade.lambda_exec import run_extension_fill
	config = Path(__file__).parents[1] / f'configs/pyramids/{config_name}.yaml'
	run_extension_fill(
		config.read_text(),
		fill_limit=limit,
		dry_run=dry_run,
		register=not no_register,
		pyramid_name=config_name,
	)


@gbfs_lambda.command('rebuild', help='Fan-out bulk rebuild: discover gaps locally, sync-invoke the rebuild Lambda once per shard, layered (tier, rung) finest-first (specs/avail-v3-lambda-rebuild.md).')
@option('-B', '--stale-before', default=None, help='Treat shards last-modified before this UTC ISO 8601 timestamp as stale — rebuild them in place.')
@option('-c', '--concurrency', type=int, default=16, show_default=True, help='Max concurrent Lambda invocations (function is unreserved; this is the only bound).')
@option('-C', '--config', 'config_name', default='avail', show_default=True, help='Pyramid config basename under configs/pyramids/ (also the D1 pyramid name).')
@option('-f', '--function', 'function_name', default=None, help='Lambda function to invoke [default: ctbk-avail-rebuild].')
@option('-k', '--keep-scaffolds', is_flag=True, help='Leave scaffold shards on R2 after a clean run (they are unregistered; a later re-run reuses them).')
@option('-L', '--limit', type=int, default=None, help='Stop after this many shards.')
@option('-n', '--dry-run', is_flag=True, help='Discover + print the layer plan with wall/cost estimates; invoke nothing.')
@option('--dot', 'dot_path', default=None, help='With -n: also write a Graphviz DAG of the build plan to this path.')
@option('-T', '--touch-tick', is_flag=True, help='First recycle the tick function\'s containers (env bump) and raise stale_before to the touch time — required for denorm re-keys, where warm ticks may keep writing tail shards with the OLD cached station-luc chains.')
def gbfs_lambda_rebuild(
	stale_before: str | None,
	concurrency: int,
	config_name: str,
	function_name: str | None,
	keep_scaffolds: bool,
	limit: int | None,
	dry_run: bool,
	dot_path: str | None,
	touch_tick: bool,
) -> None:
	from ctbk.pyramid_cascade.rebuild import REBUILD_FUNC, run_rebuild
	if stale_before is not None:
		sb = datetime.fromisoformat(stale_before)
		if sb.tzinfo is None:
			sb = sb.replace(tzinfo=timezone.utc)
	else:
		sb = None
	if sb is not None and not touch_tick:
		err('note: -B without -T — if this rebuild follows a station-luc re-key, '
			'warm tick containers may still write stale tail shards; consider -T')
	config = Path(__file__).parents[1] / f'configs/pyramids/{config_name}.yaml'
	run_rebuild(
		config.read_text(),
		stale_before=sb,
		touch_tick=touch_tick,
		concurrency=concurrency,
		function_name=function_name or REBUILD_FUNC,
		dry_run=dry_run,
		limit=limit,
		keep_scaffolds=keep_scaffolds,
		config_name=config_name,
		dot_path=dot_path,
	)


@gbfs_lambda.command('reconcile', help='Run the registration reconcile locally (laptop → true D1 primary): register expected∩storage shards missing from the registry. Containment for the 2026-07-28 D1 REST split-brain (Lambda-side writes forked).')
@option('-C', '--config', 'config_name', default='avail-v5', show_default=True, help='Pyramid config basename (also the D1 pyramid name).')
@option('-n', '--dry-run', is_flag=True, help='Print stranded keys; no writes.')
def gbfs_lambda_reconcile(config_name: str, dry_run: bool) -> None:
	from pyrmts import parse_pyramid_yaml, pyramid_from_config
	from ctbk.pyramid_cascade.d1_http import d1_query, register_shard
	from ctbk.pyramid_cascade.engine_check import merged_yaml
	from ctbk.pyramid_cascade.fsck import discover_gaps
	from ctbk.pyramid_cascade.lite import AVAIL_GENESIS
	from ctbk.pyramid_cascade.storage import storage_from_cfg
	cfg = parse_pyramid_yaml(merged_yaml(config_name))
	pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
	now = datetime.now(timezone.utc)
	_gaps, existing, expected_by_tier = discover_gaps(pyramid, (AVAIL_GENESIS, now))
	registered = {r['key'] for r in d1_query('SELECT key FROM pyramid_shards WHERE pyramid = ?', [config_name])}
	stranded = [
		e for shards in expected_by_tier.values() for e in shards
		if e.key in existing and e.key not in registered
	]
	if dry_run:
		for e in stranded:
			print(e.key)
		err(f'{len(stranded)} stranded ({config_name})')
		return
	for e in stranded:
		register_shard(
			pyramid=config_name,
			tier=e.tier,
			shard_dur=e.shard_dur,
			period_start_ms=int(e.period_start.timestamp() * 1000),
			period_end_ms=int(e.period_end.timestamp() * 1000),
			key=e.key,
			written_at_ms=int(now.timestamp() * 1000),
		)
	print(f'{config_name}: re-registered {len(stranded)}')


@gbfs_lambda.command('invoke', help='Async-invoke the Lambda (fire one fill run now instead of waiting for the cron tick).')
@option('-C', '--config', 'config_name', default=None, help='Pyramid config payload (e.g. avail-v5) [default: none → handler default `avail`].')
@option('-f', '--function', 'function_name', default=LAMBDA_FUNC, show_default=True, help='Lambda function name.')
def gbfs_lambda_invoke(config_name: str | None, function_name: str) -> None:
	import boto3
	payload = json.dumps({'config': config_name}).encode() if config_name else b'{}'
	resp = boto3.client('lambda').invoke(
		FunctionName=function_name, InvocationType='Event', Payload=payload)
	print(f"status: {resp['StatusCode']}")


@gbfs_lambda.command('logs', help='Recent CloudWatch log lines (filtered to fill activity).')
@option('-a', '--all', 'show_all', is_flag=True, help='All lines, not just fill summaries/writes/errors.')
@option('-f', '--function', 'function_name', default=LAMBDA_FUNC, show_default=True, help='Lambda function name (log group /aws/lambda/<name>).')
@option('-m', '--minutes', type=int, default=30, show_default=True, help='Look-back window.')
def gbfs_lambda_logs(show_all: bool, function_name: str, minutes: int) -> None:
	import re
	import boto3
	logs = boto3.client('logs')
	start = int((datetime.now(timezone.utc) - timedelta(minutes=minutes)).timestamp() * 1000)
	pat = re.compile(r'fillable gaps|extension fill|wrote \(|no_inputs|ERROR|Task timed|REPORT')
	paginator = logs.get_paginator('filter_log_events')
	for page in paginator.paginate(logGroupName=f'/aws/lambda/{function_name}', startTime=start):
		for ev in page['events']:
			msg = ev['message'].rstrip()
			if show_all or pat.search(msg):
				ts = datetime.fromtimestamp(ev['timestamp'] / 1000, timezone.utc).strftime('%H:%M:%S')
				print(f'{ts} {msg[:160]}')


# ─── Cross-pyramid API parity + latency (avail-v5 cutover) ─────────────

API_URLS = {
	'dev': 'https://ctbk-gbfs-api-dev.ryan-0dc.workers.dev',
	'prod': 'https://ctbk-gbfs-api.ryan-0dc.workers.dev',
}
AVAIL_METRIC_NAMES = ('bikes', 'ebikes', 'docks', 'disabled', 'pending')


@gbfs.command('parity', help='API-level parity + latency: query the baseline (`avail`) and candidate (`avail-v5`) pyramids over a station + coarse-cell matrix, compare series values, report timings. Station mapping: v3 `cells=<LUC L15 cell>` ≡ v5 `cells=s:<short_name>`. `-B` adds v5 bbox-exactness cases (bbox rollup ≡ rollup of its stations\' identity keys).')
@option('-B', '--bbox', 'bboxes', multiple=True, help='v5 bbox exactness case, `minLat,minLng,maxLat,maxLng` (repeatable) [default: one Bay Ridge box].')
@option('-b', '--bin-budget', type=int, default=24, show_default=True, help='Bins per query.')
@option('-c', '--cell', 'coarse_cells', multiple=True, help='Coarse vocab cell to compare on both pyramids (repeatable) [default: 3 built-ins].')
@option('-e', '--env', 'env_name', type=click.Choice(['dev', 'prod']), default='dev', show_default=True)
@option('-n', '--num-stations', type=int, default=8, show_default=True, help='Deterministic sample size from the station registry.')
@option('-r', '--range', 'range_', default=None, help='`FROM/TO` UTC ISO [default: the last closed UTC day].')
@option('-R', '--reducer', default='mean', show_default=True)
@option('-t', '--tolerance', type=float, default=1e-9, show_default=True, help='Max abs value diff treated as equal.')
def gbfs_parity(
	bboxes: tuple[str, ...],
	bin_budget: int,
	coarse_cells: tuple[str, ...],
	env_name: str,
	num_stations: int,
	range_: str | None,
	reducer: str,
	tolerance: float,
) -> None:
	import random
	import time as _time
	base = API_URLS[env_name]
	if range_:
		from_s, _, to_s = range_.partition('/')
	else:
		day = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%d')
		from_s, to_s = f'{day}T00:00:00Z', (datetime.fromisoformat(day) + timedelta(days=1)).strftime('%Y-%m-%dT00:00:00Z')

	def q(pyramid: str, cells: str | None, bbox: str | None = None) -> tuple[dict[int, dict[str, float]], float]:
		from urllib.parse import quote
		# Identity keys embed raw short_names (spaces, `&`, …) — must be
		# percent-encoded or urllib rejects the URL outright.
		sel = f'cells={quote(cells, safe=",:._-")}' if cells is not None else f'bbox={bbox}'
		# `cb=`: /api/avail-v3 responses are CF-cached 24h immutable — every
		# probe must cache-bust or it compares stale entries.
		url = (f'{base}/api/avail-v3?from={from_s}&to={to_s}&bin_budget={bin_budget}'
			   f'&reducer={reducer}&{sel}&cb={random.randrange(1 << 30)}'
			   + (f'&pyramid={pyramid}' if pyramid != 'avail' else ''))
		t0 = _time.time()
		req = _urlrequest.Request(url, headers={'User-Agent': 'ctbk-parity/1.0'})
		with _urlrequest.urlopen(req, timeout=60) as resp:
			body = json.loads(resp.read())
		wall = _time.time() - t0
		out: dict[int, dict[str, float]] = {}
		for rec in body.get('records', []):
			out[rec['dt']] = {m: rec.get(m) for m in AVAIL_METRIC_NAMES}
		return out, wall

	def diff(a: dict, b: dict) -> tuple[int, float, int]:
		"""(mismatched values, max abs diff, bins only on one side)."""
		mism, mx = 0, 0.0
		for dt in a.keys() & b.keys():
			for m in AVAIL_METRIC_NAMES:
				va, vb = a[dt][m], b[dt][m]
				if va is None or vb is None:
					if va != vb:
						mism += 1
					continue
				d = abs(va - vb)
				mx = max(mx, d)
				if d > tolerance:
					mism += 1
		return mism, mx, len(a.keys() ^ b.keys())

	client, bucket = _r2_client()
	luc = json.loads(client.get_object(Bucket=bucket, Key='station-luc.json')['Body'].read())  # type: ignore[attr-defined]
	active = sorted(sn for sn, e in luc['by_short_name'].items() if e.get('active'))
	step = max(1, len(active) // num_stations)
	sample = active[::step][:num_stations]

	walls: dict[str, list[float]] = {'avail': [], 'avail-v5': []}
	failures = 0
	print(f'range {from_s}/{to_s} · {len(sample)} stations · reducer={reducer} · env={env_name}')
	for sn in sample:
		cell = luc['by_short_name'][sn]['cell']
		a, wa = q('avail', cell)
		b, wb = q('avail-v5', f's:{sn}')
		walls['avail'].append(wa)
		walls['avail-v5'].append(wb)
		mism, mx, lonely = diff(a, b)
		ok = mism == 0 and lonely == 0
		failures += 0 if ok else 1
		print(f'  {"✓" if ok else "✗"} s:{sn:<10} bins {len(a)}/{len(b)}  mismatches {mism}  maxΔ {mx:.2e}  lonely {lonely}  ({wa:.2f}s vs {wb:.2f}s)')
	for bb in bboxes or ('40.60,-74.05,40.62,-74.02',):
		# v5 bbox exactness: the bbox's vocab cover must serve exactly the
		# union of its stations' identity rows (cell rows ≡ Σ member
		# stations by construction — same monoid).
		mn_lat, mn_lng, mx_lat, mx_lng = (float(x) for x in bb.split(','))
		wanted = sorted(
			sn for sn, e in luc['by_short_name'].items()
			if mn_lat <= e['lat'] <= mx_lat and mn_lng <= e['lng'] <= mx_lng
		)
		a, wa = q('avail-v5', None, bbox=bb)
		b, wb = q('avail-v5', ','.join(f's:{sn}' for sn in wanted))
		walls['avail-v5'] += [wa, wb]
		mism, mx, lonely = diff(a, b)
		ok = mism == 0 and lonely == 0
		failures += 0 if ok else 1
		print(f'  {"✓" if ok else "✗"} bbox {bb} ({len(wanted)} stations)  bins {len(a)}/{len(b)}  mismatches {mism}  maxΔ {mx:.2e}  lonely {lonely}  ({wa:.2f}s vs {wb:.2f}s)')
	for cell in coarse_cells or ('89c2454', '89c245', '89c25c4'):
		a, wa = q('avail', cell)
		b, wb = q('avail-v5', cell)
		walls['avail'].append(wa)
		walls['avail-v5'].append(wb)
		mism, mx, lonely = diff(a, b)
		ok = mism == 0 and lonely == 0
		failures += 0 if ok else 1
		print(f'  {"✓" if ok else "✗"} cell {cell:<8} bins {len(a)}/{len(b)}  mismatches {mism}  maxΔ {mx:.2e}  lonely {lonely}  ({wa:.2f}s vs {wb:.2f}s)')
	for name, ws in walls.items():
		ws = sorted(ws)
		p50, p95 = ws[len(ws) // 2], ws[min(len(ws) - 1, int(len(ws) * 0.95))]
		print(f'latency {name}: p50 {p50:.2f}s  p95 {p95:.2f}s  n={len(ws)}')
	sys.exit(1 if failures else 0)


# ─── shard invalidation (specs/shard-invalidation-adoption.md) ─────────


@gbfs.command('invalidate', help='Append a repair interval `[FROM, TO)` (UTC ISO) to the pyramid\'s R2 invalidation journal; the next extension-fill tick rebuilds every overlapping built shard in place (fine→coarse, re-registered). With -l, just print the journal.')
@option('-C', '--config', 'config_name', default='avail-v5', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-l', '--list', 'list_only', is_flag=True, help='Print current journal entries; no append.')
@argument('from_', metavar='FROM', required=False)
@argument('to', metavar='TO', required=False)
def gbfs_invalidate(
	config_name: str,
	list_only: bool,
	from_: str | None,
	to: str | None,
) -> None:
	from pyrmts_engine.invalidation import invalidate, journal_key, load_invalidations
	from ctbk.pyramid_cascade.engine_check import load_pyramid
	pyramid = load_pyramid(config_name)
	if list_only:
		if from_ is not None or to is not None:
			raise click.UsageError('-l/--list takes no FROM/TO arguments')
		entries, _ = load_invalidations(pyramid)
		for e in entries:
			print(f'[{e.start.isoformat()}, {e.end.isoformat()}) requested_at={e.requested_at.isoformat()}')
		err(f'{journal_key(pyramid)}: {len(entries)} entries')
		return
	if from_ is None or to is None:
		raise click.UsageError('FROM and TO are required (or use -l/--list)')
	def parse_utc(s: str) -> datetime:
		d = datetime.fromisoformat(s)
		return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
	interval = (parse_utc(from_), parse_utc(to))
	n = invalidate(pyramid, interval)
	err(f'{journal_key(pyramid)}: appended [{interval[0].isoformat()}, {interval[1].isoformat()}) — {n} entries pending repair')


# ─── pyrmts-engine validation (specs/pyrmts-engine-validation.md) ──────


@gbfs.group('engine', help='pyrmts-engine `build_local` validation: scratch-prefix rebuilds + content compare vs the Lambda fan-out build.')
def gbfs_engine() -> None:
	pass


def _engine_range(aligned: str | None, range_: str | None) -> tuple[datetime, datetime]:
	from ctbk.pyramid_cascade.engine_check import aligned_range
	from ctbk.pyramid_cascade.lite import AVAIL_GENESIS
	if (aligned is None) == (range_ is None):
		raise click.UsageError('exactly one of -a/--aligned or -r/--range is required')
	if aligned is not None:
		dur, _, n = aligned.partition(':')
		return aligned_range(dur, int(n or 1))
	from_s, _, to_s = range_.partition('/')
	from_ = datetime.fromisoformat(from_s).replace(tzinfo=timezone.utc) if from_s else AVAIL_GENESIS
	to = datetime.fromisoformat(to_s).replace(tzinfo=timezone.utc)
	return from_, to


@gbfs_engine.command('build', help='Run `build_local` over the range, writing to the scratch prefix + JSONL manifest (never serving keys, never D1).')
@option('-a', '--aligned', default=None, help='Smoke range: DUR[:N] = first N epoch-aligned DUR periods after genesis (e.g. `16d`, `2d:4`).')
@option('-C', '--config', 'config_name', default='avail-v4', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-m', '--manifest', default=None, help='JSONL manifest path [default: tmp/engine-check-manifest.jsonl].')
@option('-p', '--prefix', 'scratch_prefix', default=None, help='Scratch key prefix [default: <config>-engine-check].')
@option('-r', '--range', 'range_', default=None, help='Half-open build range `[FROM]/TO` (UTC ISO; FROM defaults to genesis).')
@option('-s', '--source', 'source_rung', default='1m@2d', show_default=True, help='Materialized rung to read, `tier@shard_dur` — or `raw` to build from the daily status parquets (LU-attributed; engine writes every rung incl. /1m).')
@option('-v', '--verbose', is_flag=True, help='Per-flush progress on stderr.')
@option('-w', '--window', default='12h', show_default=True, help='Streaming window Duration (memory dial).')
def gbfs_engine_build(
	aligned: str | None,
	config_name: str,
	manifest: str | None,
	scratch_prefix: str | None,
	range_: str | None,
	source_rung: str,
	verbose: bool,
	window: str,
) -> None:
	from ctbk.pyramid_cascade.engine_check import DEFAULT_MANIFEST, run_build
	time_range = _engine_range(aligned, range_)
	raw = source_rung == 'raw'
	source_tier, _, source_shard = ('', '', '') if raw else source_rung.partition('@')
	err(f'range: {time_range[0].isoformat()} → {time_range[1].isoformat()}')
	result = run_build(
		config_name,
		time_range,
		scratch_prefix=scratch_prefix or f'{config_name}-engine-check',
		manifest=manifest or DEFAULT_MANIFEST,
		**({'raw': True} if raw else {'source_tier': source_tier, 'source_shard': source_shard}),
		window=window,
		verbose=verbose,
	)
	print(result.summary())


@gbfs_engine.command('compare', help='Content-compare every manifest shard vs the fan-out build at the same key suffix (parsed long-form equality).')
@option('-C', '--config', 'config_name', default='avail-v4', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-d', '--detail', is_flag=True, help='Per-shard line for every diff/missing.')
@option('-L', '--limit', type=int, default=None, help='Only compare the first N manifest keys.')
@option('-m', '--manifest', default=None, help='JSONL manifest path [default: tmp/engine-check-manifest.jsonl].')
@option('-p', '--prefix', 'scratch_prefix', default=None, help='Scratch key prefix [default: <config>-engine-check].')
def gbfs_engine_compare(
	config_name: str,
	detail: bool,
	limit: int | None,
	manifest: str | None,
	scratch_prefix: str | None,
) -> None:
	from ctbk.pyramid_cascade.engine_check import DEFAULT_MANIFEST, compare_shards
	buckets = compare_shards(
		config_name,
		scratch_prefix=scratch_prefix or f'{config_name}-engine-check',
		manifest=manifest or DEFAULT_MANIFEST,
		limit=limit,
		detail=detail,
	)
	for name, keys in buckets.items():
		print(f'{name}: {len(keys)}')
	if buckets['diff'] or buckets['missing']:
		sys.exit(1)


@gbfs_engine.command('config', help='Emit the merged-ladder config YAML re-keyed under the scratch prefix (what a scratch/Batch build consumes). With -R, emit it at its own real prefix (standing up a new prod pyramid).')
@option('-C', '--config', 'config_name', default='avail-v4', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-o', '--out', default=None, help='Write to this local path instead of stdout.')
@option('-p', '--prefix', 'scratch_prefix', default=None, help='Scratch key prefix [default: <config>-engine-check].')
@option('-R', '--real', is_flag=True, help='No re-key: merged config at the config\'s own prefix (refused for the live-serving pyramid).')
@option('-u', '--upload', is_flag=True, help='PUT to r2://<bucket>/<prefix>/config.yaml.')
def gbfs_engine_config(
	config_name: str,
	out: str | None,
	scratch_prefix: str | None,
	real: bool,
	upload: bool,
) -> None:
	from ctbk.pyramid_cascade.engine_check import config_prefix, merged_yaml, scratch_yaml
	if real:
		# The tick Lambda + FE currently serve `avail` (v3); a real-prefix
		# config for it would let a Batch build overwrite serving keys.
		if config_name == 'avail':
			raise click.ClickException('refusing -R for the live-serving pyramid (avail)')
		if scratch_prefix is not None:
			raise click.UsageError('-R and -p are mutually exclusive')
		yml = merged_yaml(config_name)
		prefix = config_prefix(yml)
	else:
		prefix = scratch_prefix or f'{config_name}-engine-check'
		yml = scratch_yaml(config_name, prefix)
	if out:
		Path(out).write_text(yml)
		err(f'wrote {out}')
	if upload:
		client, bucket = _r2_client()
		key = f'{prefix}/config.yaml'
		client.put_object(Bucket=bucket, Key=key, Body=yml.encode(), ContentType='application/yaml')  # type: ignore[attr-defined]
		err(f'→ r2://{bucket}/{key} ({len(yml):,} B)')
	if not (out or upload):
		print(yml, end='')


@gbfs_engine.command('seed', help='Reset the scratch prefix for an engine build: wipe it, server-side-copy the source rung from the real prefix, upload the scratch config.')
@option('-C', '--config', 'config_name', default='avail-v4', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-n', '--dry-run', is_flag=True, help='Print planned deletes/copies without executing.')
@option('-p', '--prefix', 'scratch_prefix', default=None, help='Scratch key prefix [default: <config>-engine-check].')
@option('-s', '--source', 'source_rung', default='1m@2d', show_default=True, help='Materialized rung to seed, `tier@shard_dur`.')
def gbfs_engine_seed(
	config_name: str,
	dry_run: bool,
	scratch_prefix: str | None,
	source_rung: str,
) -> None:
	from ctbk.pyramid_cascade.engine_check import config_prefix, merged_yaml, scratch_yaml
	prefix = scratch_prefix or f'{config_name}-engine-check'
	yml = scratch_yaml(config_name, prefix)  # also guards prefix != real
	real = config_prefix(merged_yaml(config_name))
	tier, _, dur = source_rung.partition('@')
	client, bucket = _r2_client()
	paginator = client.get_paginator('list_objects_v2')  # type: ignore[attr-defined]

	def list_keys(pfx: str) -> list[str]:
		return [
			c['Key']
			for page in paginator.paginate(Bucket=bucket, Prefix=pfx)
			for c in page.get('Contents') or []
		]

	old = list_keys(f'{prefix}/')
	src_keys = list_keys(f'{real}/{tier}/{dur}/')
	if not src_keys:
		raise click.ClickException(f'no source shards under {real}/{tier}/{dur}/')
	if dry_run:
		err(f'would delete {len(old)} keys under {prefix}/, copy {len(src_keys)} {tier}@{dur} shards, upload config')
		return
	for i in range(0, len(old), 1000):
		batch = old[i:i + 1000]
		client.delete_objects(Bucket=bucket, Delete={'Objects': [{'Key': k} for k in batch]})  # type: ignore[attr-defined]
	err(f'deleted {len(old)} keys under {prefix}/')
	for key in src_keys:
		dest = key.replace(f'{real}/', f'{prefix}/', 1)
		client.copy_object(Bucket=bucket, Key=dest, CopySource={'Bucket': bucket, 'Key': key})  # type: ignore[attr-defined]
	err(f'copied {len(src_keys)} {tier}@{dur} shards → {prefix}/{tier}/{dur}/')
	client.put_object(Bucket=bucket, Key=f'{prefix}/config.yaml', Body=yml.encode(), ContentType='application/yaml')  # type: ignore[attr-defined]
	err(f'uploaded {prefix}/config.yaml')


@gbfs_engine.command('jobdef', help='Register a new `pyrmts-engine` job-definition revision: latest revision\'s properties with the container image swapped (creds/env copied wholesale, never read).')
@option('-n', '--dry-run', is_flag=True, help='Print current + new image; no registration.')
@argument('image', metavar='IMAGE')
def gbfs_engine_jobdef(dry_run: bool, image: str) -> None:
	import boto3
	batch = boto3.client('batch', region_name='us-east-1')
	defs = batch.describe_job_definitions(jobDefinitionName='pyrmts-engine', status='ACTIVE')['jobDefinitions']
	latest = max(defs, key=lambda d: d['revision'])
	props = latest['containerProperties']
	err(f"rev {latest['revision']}: {props['image']}")
	if dry_run:
		err(f'would register: {image}')
		return
	props['image'] = image
	out = batch.register_job_definition(
		jobDefinitionName='pyrmts-engine',
		type='container',
		containerProperties=props,
		platformCapabilities=latest.get('platformCapabilities', ['FARGATE']),
	)
	err(f"registered rev {out['revision']}: {image}")


@gbfs_engine.command('submit', help='Submit an engine build of the scratch prefix to AWS Batch (`pyrmts-engine batch submit` passthrough with the standard ctbk args).')
@option('-a', '--aligned', default=None, help='Smoke range: DUR[:N] = first N epoch-aligned DUR periods after genesis.')
@option('-b', '--mem-budget', default=None, help='Window-admission byte budget, e.g. 24g (build -b; default 70% of the cgroup limit).')
@option('-C', '--config', 'config_name', default='avail-v4', show_default=True, help='Pyramid config basename under configs/pyramids/.')
@option('-c', '--close-chunk', default=None, help='Target combined-long bytes per close chunk, e.g. 1g (build -c).')
@option('-e', '--env', 'envs', multiple=True, help='Extra container env var NAME=VALUE (repeatable).')
@option('-f', '--fill', is_flag=True, help='Declarative gap-fill: diff expected min-cover vs actual storage, build only missing (build -f; range optional, defaults genesis→now). See pyrmts specs/engine-fill-mode.md.')
@option('-g', '--rg-size', type=int, default=2048, show_default=True, help='Output-shard parquet row-group size.')
@option('-j', '--workers', type=int, default=None, help='Window-worker threads (build -j; default: job vCPUs).')
@option('-K', '--max-inflight', type=int, default=None, help='Max windows in flight past the watermark (build -K).')
@option('-k', '--close-workers', type=int, default=None, help='Concurrent close computations (build -C).')
@option('-M', '--memory', type=int, default=None, help='Override job memory MiB (e.g. 122880 needs -V 16).')
@option('-m', '--manifest', 'manifest_name', default='manifest.jsonl', show_default=True, help='Manifest object name under the scratch prefix.')
@option('-n', '--dry-run', is_flag=True, help='Print the submit command without running it.')
@option('-p', '--prefix', 'scratch_prefix', default=None, help='Scratch key prefix [default: <config>-engine-check].')
@option('-r', '--range', 'range_', default=None, help='Half-open build range `[FROM]/TO` (UTC ISO; FROM defaults to genesis).')
@option('-s', '--source', 'source_rung', default='1m', show_default=True, help='Source tier, `tier` (min-cover: read the tier as stored) or `tier@shard_dur` (pin one rung, e.g. seeded scratch).')
@option('-u', '--resume', is_flag=True, help='Skip shards already in the manifest (resume after a Spot reclaim).')
@option('-V', '--vcpus', type=int, default=None, help='Override job vCPUs.')
@option('-W', '--watch', is_flag=True, help='Tail the job log stream; exit with its status.')
@option('-w', '--window', default='12h', show_default=True, help='Streaming window Duration (memory dial).')
@option('-x', '--source-factory', 'source_spec', default=None, help='Source factory module:attr (needs an app-derived image; overrides -s).')
def gbfs_engine_submit(
	aligned: str | None,
	mem_budget: str | None,
	config_name: str,
	close_chunk: str | None,
	envs: tuple[str, ...],
	fill: bool,
	rg_size: int,
	workers: int | None,
	max_inflight: int | None,
	close_workers: int | None,
	memory: int | None,
	manifest_name: str,
	dry_run: bool,
	scratch_prefix: str | None,
	range_: str | None,
	source_rung: str,
	resume: bool,
	vcpus: int | None,
	watch: bool,
	window: str,
	source_spec: str | None,
) -> None:
	prefix = scratch_prefix or f'{config_name}-engine-check'
	bucket = os.environ.get('R2_BUCKET', 'ctbk')
	from ctbk.pyramid_cascade.engine_check import _rides_anchor
	sort = 'cell,dt,gender,user_type,bike_type' if _rides_anchor(config_name) else 's2_cell,dt'
	cmd = [
		'pyrmts-engine', 'batch', 'submit',
		# Batch job names reject '/' (multi-segment prefixes like
		# `rides-v5/start`); manifest + config paths keep the real prefix.
		'-n', prefix.replace('/', '-'),
		'-w', window,
		'-g', str(rg_size),
		'-s', sort,
		'-m', f's3://{bucket}/{prefix}/{manifest_name}',
	]
	if fill and aligned is None and range_ is None:
		# Genesis→now defaulting is ctbk's job — the engine has no genesis
		# knowledge and keeps `-r` required even under `-f`.
		from ctbk.pyramid_cascade.lite import AVAIL_GENESIS
		from_, to = AVAIL_GENESIS, datetime.now(timezone.utc)
	else:
		from_, to = _engine_range(aligned, range_)
	cmd += ['-r', f'{from_.strftime("%Y-%m-%dT%H:%M")}/{to.strftime("%Y-%m-%dT%H:%M")}']
	if fill:
		cmd += ['-f']
	if source_spec is not None:
		cmd += ['-x', source_spec]
	else:
		tier, _, dur = source_rung.partition('@')
		cmd += ['-t', tier]
		if dur:
			cmd += ['-d', dur]
	if resume:
		cmd += ['-u']
	if mem_budget is not None:
		cmd += ['-b', mem_budget]
	if workers is not None:
		cmd += ['--workers', str(workers)]
	if max_inflight is not None:
		cmd += ['-K', str(max_inflight)]
	if close_workers is not None:
		cmd += ['-C', str(close_workers)]
	if close_chunk is not None:
		cmd += ['-c', close_chunk]
	if memory is not None:
		cmd += ['-M', str(memory)]
	if vcpus is not None:
		cmd += ['-V', str(vcpus)]
	for e in envs:
		cmd += ['-e', e]
	if watch:
		cmd += ['-W']
	cmd += [f's3://{bucket}/{prefix}/config.yaml']
	if dry_run:
		print(' '.join(cmd))
		return
	sys.exit(subprocess.run(cmd).returncode)


def _load_manifest(path: str) -> list[dict]:
	"""JSONL manifest records from a local path or `s3://` URL (ctbk R2 bucket)."""
	if path.startswith('s3://'):
		bkt, _, key = path[len('s3://'):].partition('/')
		client, bucket = _r2_client()
		if bkt != bucket:
			raise click.ClickException(f'bucket {bkt!r} != configured {bucket!r}')
		body = client.get_object(Bucket=bucket, Key=key)['Body'].read()  # type: ignore[attr-defined]
		lines = body.decode().splitlines()
	else:
		lines = Path(path).read_text().splitlines()
	return [json.loads(l) for l in lines if l.strip()]


@gbfs_engine.command('register', help='Register manifest shards in the D1 `pyramid_shards` registry (INSERT OR REPLACE; idempotent). Complements the cascade Lambda, which registers its own writes.')
@option('-b', '--batch-size', type=int, default=12, show_default=True, help='Rows per D1 statement.')
@option('-n', '--dry-run', is_flag=True, help='Print row count + a sample; no D1 writes.')
@option('-P', '--pyramid', 'pyramid_name', default=None, help='Registry pyramid name [default: each record\'s own `pyramid` field].')
@argument('manifest', metavar='MANIFEST')
def gbfs_engine_register(
	batch_size: int,
	dry_run: bool,
	pyramid_name: str | None,
	manifest: str,
) -> None:
	from ctbk.pyramid_cascade.d1_http import d1_query
	recs = []
	seen = set()
	for r in _load_manifest(manifest):
		if r['key'] not in seen:
			seen.add(r['key'])
			recs.append(r)
	if dry_run:
		names = Counter(pyramid_name or r['pyramid'] for r in recs)
		print(f'{len(recs)} shards → pyramid_shards as {dict(names)}')
		return
	cols = '(pyramid, tier, shard_dur, period_start, period_end, key, written_at)'
	for i in range(0, len(recs), batch_size):
		chunk = recs[i:i + batch_size]
		placeholders = ', '.join(['(?, ?, ?, ?, ?, ?, ?)'] * len(chunk))
		params: list = []
		for r in chunk:
			params += [
				pyramid_name or r['pyramid'], r['tier'], r['shard_dur'],
				r['period_start'], r['period_end'], r['key'], r['written_at'],
			]
		d1_query(f'INSERT OR REPLACE INTO pyramid_shards {cols} VALUES {placeholders}', params)
		err(f'  registered {i + len(chunk)}/{len(recs)}')


@gbfs_engine.command('manifest', help='Summarize a build manifest (local path or `s3://` URL): shard counts per (tier, rung), period span; optionally diff key sets vs another manifest.')
@option('-d', '--diff', 'other', default=None, help='Second manifest; report key-set differences.')
@argument('path', metavar='PATH')
def gbfs_engine_manifest(other: str | None, path: str) -> None:
	load = _load_manifest
	recs = load(path)
	by_rung = Counter((r['tier'], r['shard_dur']) for r in recs)
	starts = [r['period_start'] for r in recs]
	ends = [r['period_end'] for r in recs]
	fmt = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M')
	print(f'{len(recs)} shards, periods {fmt(min(starts))} → {fmt(max(ends))}')
	for (tier, dur), n in sorted(by_rung.items()):
		print(f'  {tier:>4}@{dur:<5} {n}')
	if other:
		a = {r['key'] for r in recs}
		b = {r['key'] for r in load(other)}
		for label, only in [(f'only in {path}', a - b), (f'only in {other}', b - a)]:
			print(f'{label}: {len(only)}')
			for k in sorted(only):
				print(f'  {k}')
		if a != b:
			sys.exit(1)


@gbfs_r2.command('pq', help='Inspect a parquet object on R2: schema + row count; optionally head rows and row-group metadata (range reads, no full download).')
@option('-m', '--metadata', 'show_meta', is_flag=True, help='Row-group count/sizes and file metadata.')
@option('-n', '--head', 'head_n', type=int, default=0, help='Print the first N rows.')
@argument('key', metavar='KEY')
def gbfs_r2_pq(show_meta: bool, head_n: int, key: str) -> None:
	import pyarrow.parquet as pq
	import s3fs
	acct = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
	akid = os.environ.get('R2_ACCESS_KEY_ID')
	sk = os.environ.get('R2_SECRET_ACCESS_KEY')
	if not (acct and akid and sk):
		raise click.ClickException('CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set. `source .envrc`.')
	bucket = os.environ.get('R2_BUCKET', 'ctbk')
	fs = s3fs.S3FileSystem(
		key=akid,
		secret=sk,
		endpoint_url=f'https://{acct}.r2.cloudflarestorage.com',
	)
	with fs.open(f'{bucket}/{key}') as f:
		pf = pq.ParquetFile(f)
		md = pf.metadata
		print(f'{key}: {md.num_rows:,} rows, {md.num_row_groups} row groups')
		print(pf.schema_arrow)
		if show_meta:
			for i in range(md.num_row_groups):
				rg = md.row_group(i)
				print(f'  rg {i}: {rg.num_rows:,} rows, {rg.total_byte_size:,} B')
		if head_n:
			batch = next(pf.iter_batches(batch_size=head_n))
			print(batch.to_pandas().to_string())


# ─── feed subgroup ──────────────────────────────────────────────────────
#
# Upstream-feed characterization: how often does `last_updated` (LU)
# advance, how stale is the content we receive (CDN cache behavior), and
# is same-LU content byte-identical? Feeds the LU-attribution migration
# (`specs/lu-attribution.md`): using LU as time-of-record instead of the
# poller's wall clock.

# What the poller (`gbfs/worker`) fetches:
FEED_STATUS_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json'
FEED_STATUS_URL_23 = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json'

# Response headers worth recording per sample (CDN provenance / cache age).
_FEED_HDRS = [
	'age', 'cache-control', 'cf-cache-status', 'date', 'etag',
	'last-modified', 'via', 'x-amz-cf-id', 'x-amz-cf-pop', 'x-cache',
]


@gbfs.group('feed', help='Upstream GBFS feed probes: `last_updated` cadence, cache behavior, content identity.')
def gbfs_feed() -> None:
	pass


@gbfs_feed.command('probe', help='Sample the feed every INTERVAL seconds for DURATION seconds; one JSON line per sample on stdout.')
@option('-d', '--duration', type=float, default=900., show_default=True, help='Total probe wall-clock seconds.')
@option('-i', '--interval', type=float, default=5., show_default=True, help='Seconds between samples (fixed grid from start).')
@option('-n', '--no-cache', 'no_cache', is_flag=True, help='Send `Cache-Control: no-cache` (compare vs default CDN behavior).')
@option('-u', '--url', default=FEED_STATUS_URL, show_default=True, help='Feed URL (see also the 2.3 variant).')
def gbfs_feed_probe(
	duration: float,
	interval: float,
	no_cache: bool,
	url: str,
) -> None:
	import hashlib
	import time as _time

	t0 = _time.time()
	k = 0
	n_err = 0
	while True:
		target = t0 + k * interval
		now = _time.time()
		if target - t0 > duration:
			break
		if target > now:
			_time.sleep(target - now)
		k += 1
		req = _urlrequest.Request(url)
		if no_cache:
			req.add_header('Cache-Control', 'no-cache')
		t_req = _time.time()
		try:
			with _urlrequest.urlopen(req, timeout=20) as resp:
				body = resp.read()
				hdrs = {h: resp.headers.get(h) for h in _FEED_HDRS if resp.headers.get(h) is not None}
		except (HTTPError, URLError, OSError) as e:
			n_err += 1
			err(f'sample {k}: fetch failed: {e}')
			continue
		t_resp = _time.time()
		d = json.loads(body)
		stations = d.get('data', {}).get('stations', [])
		canon = json.dumps(
			sorted(stations, key=lambda s: s.get('station_id', '')),
			sort_keys=True, separators=(',', ':'),
		).encode()
		print(json.dumps({
			't': round(t_req, 3),
			'rt_ms': round((t_resp - t_req) * 1000),
			'lu': d.get('last_updated'),
			'ttl': d.get('ttl'),
			'n': len(stations),
			'body_md5': hashlib.md5(body).hexdigest(),
			'stations_md5': hashlib.md5(canon).hexdigest(),
			'hdrs': hdrs,
		}), flush=True)
	err(f'{k} samples attempted, {n_err} failed')


@gbfs_feed.command('stats', help='Analyze `feed probe` JSONL: LU cadence, detection latency, same-LU content identity, cache headers.')
@argument('paths', nargs=-1, required=True)
def gbfs_feed_stats(paths: tuple[str, ...]) -> None:
	from statistics import mean, median

	for path in paths:
		with (sys.stdin if path == '-' else open(path)) as f:
			samples = [json.loads(line) for line in f if line.strip()]
		if not samples:
			err(f'{path}: no samples')
			continue
		samples.sort(key=lambda s: s['t'])
		span = samples[-1]['t'] - samples[0]['t']
		print(f'── {path}: {len(samples)} samples over {span / 60:.1f} min')

		# LU timeline: first/last sighting per distinct LU, in time order.
		lus: list[dict] = []
		for s in samples:
			if not lus or lus[-1]['lu'] != s['lu']:
				lus.append({'lu': s['lu'], 't_first': s['t'], 't_last': s['t'], 'md5s': set(), 'body_md5s': set()})
			lus[-1]['t_last'] = s['t']
			lus[-1]['md5s'].add(s['stations_md5'])
			lus[-1]['body_md5s'].add(s['body_md5'])

		deltas = [b['lu'] - a['lu'] for a, b in zip(lus, lus[1:])]
		if deltas:
			regress = sum(1 for d in deltas if d < 0)
			print(f'  distinct LUs: {len(lus)}; cadence (s): min={min(deltas)} p50={median(deltas)} mean={mean(deltas):.1f} max={max(deltas)}'
				+ (f'; {regress} REGRESSIONS (LU went backwards)' if regress else ''))
		lat = [u['t_first'] - u['lu'] for u in lus[1:]]  # skip first (LU predates probe start)
		if lat:
			lat_s = sorted(lat)
			print(f'  detection latency (first-seen − LU, s): min={lat_s[0]:.1f} p50={lat_s[len(lat_s) // 2]:.1f} p95={lat_s[int(len(lat_s) * .95)]:.1f} max={lat_s[-1]:.1f}')

		multi = [u for u in lus if len(u['md5s']) > 1]
		multi_body = [u for u in lus if len(u['body_md5s']) > 1]
		print(f'  same-LU content: {len(multi)} of {len(lus)} LUs had >1 distinct stations_md5'
			+ f' ({len(multi_body)} >1 body_md5)')
		for u in multi[:5]:
			print(f'    LU {u["lu"]} ({datetime.fromtimestamp(u["lu"], tz=timezone.utc):%H:%M:%S}Z): {len(u["md5s"])} station-payload variants')

		hdr_counts: Counter = Counter()
		ages: list[float] = []
		for s in samples:
			h = s.get('hdrs', {})
			for key in ('x-cache', 'cf-cache-status'):
				if key in h:
					hdr_counts[f'{key}: {h[key]}'] += 1
			if 'age' in h:
				ages.append(float(h['age']))
		for hv, n in hdr_counts.most_common():
			print(f'  {hv}: {n}')
		if ages:
			ages.sort()
			print(f'  Age header (s): min={ages[0]:.0f} p50={ages[len(ages) // 2]:.0f} max={ages[-1]:.0f}')
