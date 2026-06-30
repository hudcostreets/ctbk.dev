#!/usr/bin/env -S uv run --no-project --with click --with boto3 --with pyrmts --with utz --with pyyaml
"""avail-v3 R2 + D1 rename from legacy canonical/partial layout to the
unified `{tier}/{shard_dur}/{period}` layout.

See `specs/avail-v3-storage-rename.md` for the 7-step cutover ordering.
Each subcommand corresponds to one or two steps in that runbook.

Subcommands (run in order; each is idempotent):

  plan         List what each subsequent subcommand would do (no writes).
  r2-copy      Step 1: COPY legacy R2 objs → new paths. Purely additive.
  d1-alter     Step 2 (= phase P3): ALTER COLUMN cadence → shard_dur.
               Tight-window: deploy MUST follow immediately.
  d1-update    Step 4 (= phase P5b): row-value rewrite (cadence='' →
               largest shard; rewrite pyramid_shards.key).
  r2-delete    Step 6 (= phase P5c): DELETE legacy R2 objs (post-smoke).

Steps 3 (deploy cascade + api) + 5 (smoke-test) are manual.

R2 auth: env `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (preferred)
or AWS profile `cf`. Account ID via `CLOUDFLARE_ACCOUNT_ID` /
`R2_ACCOUNT_ID`. Same convention as `ctbk/avail_v3.py`.

D1 auth: shell out to `wrangler d1 execute --remote`; expects
`wrangler login` already done. The wrangler binary is invoked from
`gbfs/api/` so its wrangler.toml binding resolves.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import yaml
from utz import err

# Lazy imports to keep `--help` snappy.
PYRAMID = 'avail'
PREFIX = 'avail-v3'
BUCKET = 'ctbk'
D1_DB = 'ctbk-gbfs'
WRANGLER_DIR = Path('gbfs/api')  # wrangler.toml that binds DB → ctbk-gbfs

# Path patterns:
#   legacy canonical  avail-v3/<tier>/<period>.parquet
#   legacy partial    avail-v3/<tier>/p<dur>/<period>.parquet
#   new (any rung)    avail-v3/<tier>/<dur>/<period>.parquet
LEGACY_PARTIAL_RE = re.compile(rf'^{PREFIX}/(?P<tier>[^/]+)/p(?P<dur>[^/]+)/(?P<period>.+)\.parquet$')
LEGACY_CANON_RE   = re.compile(rf'^{PREFIX}/(?P<tier>[^/]+)/(?P<period>[^/]+)\.parquet$')


def load_largest_per_tier(config_path: Path) -> dict[str, str]:
    """Parse the YAML and return {tier_name: largest_shard_dur}."""
    from pyrmts import parse_pyramid_yaml
    cfg = parse_pyramid_yaml(config_path.read_text())
    return {t.name: t.shards[-1] for t in cfg.tiers}


def r2_client():
    """Reuse ctbk's R2 client convention."""
    from ctbk.avail_v3 import r2_client as _r2_client
    return _r2_client()


def classify_key(key: str, largest: dict[str, str]) -> tuple[str, str] | None:
    """Return (kind, new_key) for legacy keys, else None.

    kind ∈ {'partial', 'canonical'}.
    """
    m = LEGACY_PARTIAL_RE.match(key)
    if m:
        tier, dur, period = m['tier'], m['dur'], m['period']
        return ('partial', f'{PREFIX}/{tier}/{dur}/{period}.parquet')
    m = LEGACY_CANON_RE.match(key)
    if m:
        tier, period = m['tier'], m['period']
        dur = largest.get(tier)
        if not dur:
            return None  # unknown tier; skip
        if period == 'all':
            # Legacy `<tier>/all.parquet` → unified `<tier>/<largest=120y>/1900.parquet`.
            # See spec §"Legacy 'all' → 120y period label".
            period = '1900'
        return ('canonical', f'{PREFIX}/{tier}/{dur}/{period}.parquet')
    return None


def iter_avail_keys(r2):
    """Yield every object key under `avail-v3/`. Paginated."""
    paginator = r2.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=f'{PREFIX}/'):
        for obj in page.get('Contents', []) or []:
            yield obj['Key']


def run_wrangler(sql_path: Path, dry_run: bool):
    cmd = [
        'wrangler', 'd1', 'execute', D1_DB,
        '--remote', '--file', str(sql_path.resolve()),
    ]
    err(f"$ (cd {WRANGLER_DIR} && {' '.join(cmd)})")
    if dry_run:
        return
    subprocess.run(cmd, cwd=WRANGLER_DIR, check=True)


@click.group()
@click.option('-c', '--config', type=click.Path(exists=True, path_type=Path),
              default='configs/pyramids/avail.yaml', show_default=True,
              help="Pyramid YAML — source of truth for largest-per-tier mapping.")
@click.pass_context
def main(ctx, config):
    """avail-v3 rename runbook. Each subcommand is one step from
    specs/avail-v3-storage-rename.md."""
    ctx.ensure_object(dict)
    ctx.obj['largest'] = load_largest_per_tier(config)
    ctx.obj['config_path'] = config


@main.command()
@click.pass_context
def plan(ctx):
    """Classify every R2 obj under `avail-v3/`. Counts by tier × kind.

    No writes. Run first to confirm the rename map matches expectation."""
    largest = ctx.obj['largest']
    counts: dict[tuple[str, str], int] = {}
    new_already: dict[str, int] = {}
    unknown: list[str] = []
    cli = r2_client()
    n = 0
    for key in iter_avail_keys(cli):
        n += 1
        cls = classify_key(key, largest)
        if cls is None:
            # Either already new-layout, or genuinely unrecognized.
            # New layout has 4 path segments: avail-v3/<tier>/<dur>/<period>.parquet
            parts = key.split('/')
            if len(parts) == 4 and parts[0] == PREFIX:
                new_already[parts[1]] = new_already.get(parts[1], 0) + 1
            else:
                unknown.append(key)
            continue
        kind, _ = cls
        # Extract tier for grouping.
        m = LEGACY_PARTIAL_RE.match(key) or LEGACY_CANON_RE.match(key)
        tier = m['tier']
        counts[(tier, kind)] = counts.get((tier, kind), 0) + 1
        if n % 5000 == 0:
            err(f"  scanned {n}…")
    err(f"scanned {n} objects total")

    print(f"\n=== legacy objects to rename ===")
    print(f"  {'tier':<5} {'kind':<10} {'count':>6}")
    for (tier, kind), cnt in sorted(counts.items()):
        print(f"  {tier:<5} {kind:<10} {cnt:>6}")
    total_legacy = sum(counts.values())
    print(f"  {'total':<16} {total_legacy:>6}")

    print(f"\n=== already in new layout ===")
    for tier in sorted(new_already):
        print(f"  {tier:<5} {new_already[tier]:>6}")
    print(f"  {'total':<16} {sum(new_already.values()):>6}")

    if unknown:
        print(f"\n=== unrecognized (skipping) ===")
        for k in unknown[:20]:
            print(f"  {k}")
        if len(unknown) > 20:
            print(f"  …and {len(unknown) - 20} more")


@main.command('r2-copy')
@click.option('-n', '--dry-run', is_flag=True)
@click.option('-l', '--limit', type=int, default=None,
              help="Stop after this many COPY ops (for staged smoke tests).")
@click.pass_context
def r2_copy(ctx, dry_run, limit):
    """Step 1: COPY each legacy R2 obj → new path. Purely additive.

    Idempotent: HEADs the destination first; skips if it already exists.
    Does NOT delete the source (that's `r2-delete`).
    """
    largest = ctx.obj['largest']
    cli = r2_client()
    n_copied = n_already = n_skip = 0
    for key in iter_avail_keys(cli):
        cls = classify_key(key, largest)
        if cls is None:
            # Already-new or unrecognized; r2-copy doesn't touch those.
            continue
        _, new_key = cls
        if new_key == key:
            n_skip += 1
            continue  # would be a self-copy
        # Idempotent: skip if destination exists.
        try:
            cli.head_object(Bucket=BUCKET, Key=new_key)
            n_already += 1
            continue
        except cli.exceptions.ClientError:
            pass
        if dry_run:
            err(f"  would COPY {key} → {new_key}")
        else:
            cli.copy_object(
                Bucket=BUCKET, Key=new_key,
                CopySource={'Bucket': BUCKET, 'Key': key},
            )
        n_copied += 1
        if n_copied % 100 == 0:
            err(f"  copied {n_copied}…")
        if limit is not None and n_copied >= limit:
            err(f"  hit --limit {limit}; stopping")
            break

    err(f"COPY summary: copied={n_copied}, already-present={n_already}, skipped={n_skip}")


@main.command('r2-delete')
@click.option('-n', '--dry-run', is_flag=True)
@click.option('-y', '--yes', is_flag=True, help="Skip the confirmation prompt.")
@click.pass_context
def r2_delete(ctx, dry_run, yes):
    """Step 6: DELETE legacy R2 objs. Run AFTER the new code is deployed
    and smoke-tested — until then, the deployed old code may still read
    these paths.
    """
    largest = ctx.obj['largest']
    if not (dry_run or yes):
        click.confirm(
            "About to DELETE all legacy avail-v3 R2 objs. "
            "Confirmed that new cascade + api are deployed + smoke-tested?",
            abort=True,
        )
    cli = r2_client()
    n_deleted = 0
    for key in iter_avail_keys(cli):
        cls = classify_key(key, largest)
        if cls is None:
            continue
        _, new_key = cls
        if new_key == key:
            continue
        # Safety: only DELETE if the new key exists.
        try:
            cli.head_object(Bucket=BUCKET, Key=new_key)
        except cli.exceptions.ClientError:
            err(f"  REFUSE delete {key}: new {new_key} not present (re-run r2-copy first)")
            continue
        if dry_run:
            err(f"  would DELETE {key}")
        else:
            cli.delete_object(Bucket=BUCKET, Key=key)
        n_deleted += 1
        if n_deleted % 100 == 0:
            err(f"  deleted {n_deleted}…")
    err(f"DELETE summary: deleted={n_deleted}")


@main.command('d1-alter')
@click.option('-n', '--dry-run', is_flag=True)
def d1_alter(dry_run):
    """Step 2 (phase P3): ALTER both pyramid tables to rename cadence →
    shard_dur. **Tight window**: deploy new cascade + api IMMEDIATELY
    after; the deployed old cascade fails until then (column missing).
    """
    sql = (
        "ALTER TABLE pyramid_watermarks RENAME COLUMN cadence TO shard_dur;\n"
        "ALTER TABLE pyramid_shards     RENAME COLUMN cadence TO shard_dur;\n"
    )
    sql_path = Path('tmp/avail-v3-d1-alter.sql')
    sql_path.parent.mkdir(parents=True, exist_ok=True)
    sql_path.write_text(sql)
    err(f"wrote {sql_path}:\n{sql}")
    run_wrangler(sql_path, dry_run=dry_run)


@main.command('d1-update')
@click.option('-n', '--dry-run', is_flag=True)
@click.pass_context
def d1_update(ctx, dry_run):
    """Step 4 (phase P5b): row-value rewrite. Assumes d1-alter has run
    (so the column is named `shard_dur`).

    Per tier:
    - canonical rows: `shard_dur=''` → `shard_dur='<largest>'`,
      and `pyramid_shards.key` gets a new `<largest>` segment inserted.
    - partial rows: strip the `p` prefix from `pyramid_shards.key`.
    """
    largest = ctx.obj['largest']
    lines: list[str] = []
    for tier, dur in largest.items():
        lines.append(
            f"UPDATE pyramid_watermarks "
            f"SET shard_dur = '{dur}' "
            f"WHERE pyramid = '{PYRAMID}' AND tier = '{tier}' AND shard_dur = '';"
        )
        lines.append(
            f"UPDATE pyramid_shards "
            f"SET shard_dur = '{dur}', "
            f"    key = REPLACE(key, '{PREFIX}/{tier}/', '{PREFIX}/{tier}/{dur}/') "
            f"WHERE pyramid = '{PYRAMID}' AND tier = '{tier}' AND shard_dur = '';"
        )
        lines.append(
            f"UPDATE pyramid_shards "
            f"SET key = REPLACE(key, '{PREFIX}/{tier}/p', '{PREFIX}/{tier}/') "
            f"WHERE pyramid = '{PYRAMID}' AND tier = '{tier}' AND shard_dur != '';"
        )
    sql = '\n'.join(lines) + '\n'
    sql_path = Path('tmp/avail-v3-d1-update.sql')
    sql_path.parent.mkdir(parents=True, exist_ok=True)
    sql_path.write_text(sql)
    err(f"wrote {sql_path} ({len(lines)} statements)")
    run_wrangler(sql_path, dry_run=dry_run)


if __name__ == '__main__':
    main(obj={})
