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


@gbfs_r2.command('cp', help='Server-side copy KEY to DEST key (same bucket).')
@option('-f', '--force', is_flag=True, help='Overwrite DEST if it already exists.')
@argument('key', metavar='KEY')
@argument('dest', metavar='DEST')
def gbfs_r2_cp(force: bool, key: str, dest: str) -> None:
	client, bucket = _r2_client()
	if not force:
		try:
			client.head_object(Bucket=bucket, Key=dest)  # type: ignore[attr-defined]
			raise click.ClickException(f'{dest} exists (use -f to overwrite)')
		except client.exceptions.ClientError:  # type: ignore[attr-defined]
			pass
	client.copy_object(Bucket=bucket, Key=dest, CopySource={'Bucket': bucket, 'Key': key})  # type: ignore[attr-defined]
	err(f'{key} → {dest}')


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


@gbfs_lambda.command('invoke', help='Async-invoke the Lambda (fire one fill run now instead of waiting for the hourly cron).')
def gbfs_lambda_invoke() -> None:
	import boto3
	resp = boto3.client('lambda').invoke(
		FunctionName=LAMBDA_FUNC, InvocationType='Event', Payload=b'{}')
	print(f"status: {resp['StatusCode']}")


@gbfs_lambda.command('logs', help='Recent CloudWatch log lines (filtered to fill activity).')
@option('-m', '--minutes', type=int, default=30, show_default=True, help='Look-back window.')
@option('-a', '--all', 'show_all', is_flag=True, help='All lines, not just fill summaries/writes/errors.')
def gbfs_lambda_logs(minutes: int, show_all: bool) -> None:
	import re
	import boto3
	logs = boto3.client('logs')
	start = int((datetime.now(timezone.utc) - timedelta(minutes=minutes)).timestamp() * 1000)
	pat = re.compile(r'fillable gaps|extension fill|wrote \(|no_inputs|ERROR|Task timed|REPORT')
	paginator = logs.get_paginator('filter_log_events')
	for page in paginator.paginate(logGroupName=f'/aws/lambda/{LAMBDA_FUNC}', startTime=start):
		for ev in page['events']:
			msg = ev['message'].rstrip()
			if show_all or pat.search(msg):
				ts = datetime.fromtimestamp(ev['timestamp'] / 1000, timezone.utc).strftime('%H:%M:%S')
				print(f'{ts} {msg[:160]}')


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
@option('-s', '--source', 'source_rung', default='1m@2d', show_default=True, help='Materialized rung to read, `tier@shard_dur`.')
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
	source_tier, _, source_shard = source_rung.partition('@')
	err(f'range: {time_range[0].isoformat()} → {time_range[1].isoformat()}')
	result = run_build(
		config_name,
		time_range,
		scratch_prefix=scratch_prefix or f'{config_name}-engine-check',
		manifest=manifest or DEFAULT_MANIFEST,
		source_tier=source_tier,
		source_shard=source_shard,
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
