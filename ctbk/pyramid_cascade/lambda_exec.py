"""Lambda-executor cascade: ladder-extension rungs (`lambda_shards`).

Phase 1 of `specs/avail-v3-lambda-cascade.md`: build the per-tier rungs
ABOVE the CFW's `shards` ladder (N ≤ 4096 vs the CFW's N ≤ 960), from
each tier's own existing cover.

Extension shards are same-tier consolidations with matching bins, so no
re-aggregation is needed: read the sub-rung cover tiles (disjoint,
aligned), concat, sort `(s2_cell, dt)`, write. Peak memory is one
output table (~100-200 B/row in Arrow → ≤ ~3 GB at N=4096), NOT the
`materialize_shard` long-frame explode (~17 GB at N=1440) — that's what
makes these buildable in a 10 GB Lambda.

Runs identically on a laptop (`ctbk gbfs lambda fill`) and in the AWS
Lambda handler (`gbfs/lambda/handler.py`).
"""
from __future__ import annotations

import io
import time as _time
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq
import yaml as _yaml
from pyrmts import ExpectedShard, parse_pyramid_yaml, pyramid_from_config
from pyrmts.gap_discovery import _cover_for_tier
from pyrmts.types import Tier
from utz import err

from .config import parse_rg_sizes, rg_size_for
from .lite import AVAIL_GENESIS, R2_BUCKET, MaterializeResult, dur_min


def parse_lambda_shards(yaml_text: str) -> dict[str, list[str]]:
    """`{tier_name: [extension rungs]}` for tiers declaring `lambda_shards`."""
    raw = _yaml.safe_load(yaml_text)
    out: dict[str, list[str]] = {}
    for t in raw.get('tiers') or []:
        ext = t.get('lambda_shards')
        if ext:
            out[t['name']] = [str(d) for d in ext]
    return out


def merge_lambda_shards(yaml_text: str) -> str:
    """Return YAML text with each tier's `shards` extended by its
    `lambda_shards` — the Lambda executor's view of the ladder. Enforces
    that each extension continues the tier's divisibility chain."""
    raw = _yaml.safe_load(yaml_text)
    for t in raw.get('tiers') or []:
        ext = t.pop('lambda_shards', None)
        if not ext:
            continue
        shards = list(t['shards'])
        prev = dur_min(str(shards[-1]))
        for d in ext:
            cur = dur_min(str(d))
            if cur % prev != 0 or cur <= prev:
                raise ValueError(
                    f"tier {t['name']}: lambda_shards {d} breaks the "
                    f"divisibility chain after {shards[-1]}")
            shards.append(str(d))
            prev = cur
        t['shards'] = shards
    return _yaml.safe_dump(raw, sort_keys=False)


def _sub_rung_tier_view(tier: Tier, gap_shard_dur: str) -> Tier:
    """The tier with only rungs strictly smaller than the gap's — the
    rungs its source cover may draw from (telescoping same-tier build;
    fill order guarantees smaller extension rungs land first)."""
    cap = dur_min(gap_shard_dur)
    subs = tuple(r for r in tier.shards if dur_min(r) < cap)
    return Tier(name=tier.name, bin=tier.bin, shards=subs)


def materialize_extension_shard(
    r2,
    pyramid,
    gap: ExpectedShard,
    *,
    key_set: set[str],
    rg_size: int = 2048,
) -> MaterializeResult:
    """Same-tier concat build of one extension shard. Idempotent
    (`key_set`/HEAD skip). Source = the tier's sub-rung cover of the
    gap period; cover tiles entirely pre-genesis are skipped (no data
    ever existed); any other missing tile → `no_inputs` (retry next
    invocation once the CFW/fill-order lands it)."""
    tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"
    t0 = _time.time()
    if gap.key in key_set:
        return MaterializeResult(gap=gap, status='exists')
    try:
        r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
        key_set.add(gap.key)
        return MaterializeResult(gap=gap, status='exists')
    except r2.exceptions.ClientError:
        pass
    if gap.period_end <= AVAIL_GENESIS:
        return MaterializeResult(gap=gap, status='no_inputs', inputs_present=0,
                                 inputs_expected=0, source_desc='pre-genesis')

    tier = next(t for t in pyramid.tiers if t.name == gap.tier)
    view = _sub_rung_tier_view(tier, gap.shard_dur)
    if not view.shards:
        raise ValueError(f'{tag}: no sub-rungs to cover from')
    cover = _cover_for_tier(pyramid, view, gap.period_start, gap.period_end, {})
    # Pre-genesis tiles never had data; the genesis-straddling tile exists.
    cover = [e for e in cover if e.period_end > AVAIL_GENESIS]
    missing = [e.key for e in cover if e.key not in key_set]
    inputs_expected = len(cover)
    if missing:
        # Distinguish "not in snapshot" from "not on R2" with HEADs.
        really_missing = []
        for k in missing:
            try:
                r2.head_object(Bucket=R2_BUCKET, Key=k)
                key_set.add(k)
            except r2.exceptions.ClientError:
                really_missing.append(k)
        if really_missing:
            err(f"  ⟶ {tag} → no_inputs ({len(really_missing)}/{inputs_expected} "
                f"missing, e.g. {really_missing[0]})")
            return MaterializeResult(
                gap=gap, status='no_inputs',
                inputs_present=inputs_expected - len(really_missing),
                inputs_expected=inputs_expected,
                source_desc='same-tier cover',
            )

    err(f"  ⟶ {tag} → reading {inputs_expected} cover tiles")
    tables: list[pa.Table] = []
    for e in cover:
        obj = r2.get_object(Bucket=R2_BUCKET, Key=e.key)
        t = pq.read_table(io.BytesIO(obj['Body'].read()))
        # Cover tiles span writer eras (pyarrow / hyparquet-writer / CFW
        # restat) whose schemas differ in string vs large_string; cast to
        # the canonical narrow-string schema so concat doesn't throw.
        t = t.cast(pa.schema([
            (f.name, pa.string() if pa.types.is_large_string(f.type) else f.type)
            for f in t.schema
        ]))
        tables.append(t)
    combined = pa.concat_tables(tables)
    del tables
    if combined.num_rows == 0:
        return MaterializeResult(gap=gap, status='empty',
                                 inputs_present=inputs_expected,
                                 inputs_expected=inputs_expected,
                                 source_desc='same-tier cover')
    # Cover tiles are disjoint + fit inside the gap period, so no dt
    # clipping — just the (s2_cell, dt) sort for RG-prunable layout.
    combined = combined.sort_by([('s2_cell', 'ascending'), ('dt', 'ascending')])
    buf = io.BytesIO()
    pq.write_table(combined, buf, row_group_size=rg_size, compression='snappy')
    blob = buf.getvalue()
    r2.put_object(Bucket=R2_BUCKET, Key=gap.key, Body=blob)
    key_set.add(gap.key)
    err(f"  ⟵ {tag} → wrote ({combined.num_rows:,} rows, {len(blob)/1e6:.1f}MB, "
        f"{_time.time()-t0:.1f}s)")
    return MaterializeResult(
        gap=gap, status='wrote', bytes_written=len(blob), rows=combined.num_rows,
        inputs_present=inputs_expected, inputs_expected=inputs_expected,
        source_desc=f'same-tier cover ×{inputs_expected}',
    )


def run_extension_fill(
    config_yaml: str,
    *,
    now: datetime | None = None,
    fill_limit: int | None = None,
    time_budget_s: float | None = None,
    register: bool = False,
    dry_run: bool = False,
    pyramid_name: str = 'avail',
) -> list[MaterializeResult]:
    """Discover + fill missing extension-rung shards over
    [genesis, now). With `register`, each `wrote` is INSERT-OR-REPLACEd
    into `pyramid_shards` via the D1 REST API immediately after its R2
    put (per-shard, so a mid-run abort can't strand unregistered keys
    beyond the one in flight)."""
    from .fsck import discover_gaps
    from .lite import r2_client

    now = now or datetime.now(timezone.utc)
    ext_by_tier = parse_lambda_shards(config_yaml)
    if not ext_by_tier:
        raise ValueError('config declares no lambda_shards')
    merged_yaml = merge_lambda_shards(config_yaml)
    cfg = parse_pyramid_yaml(merged_yaml)
    from .storage import storage_from_cfg
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    rg_sizes = parse_rg_sizes(config_yaml)

    gaps, existing, _expected = discover_gaps(pyramid, (AVAIL_GENESIS, now))
    # Any gap with same-tier sub-rungs to build from is ours — extension
    # rungs by design, but also in-ladder rungs the CFW couldn't produce
    # (e.g. `too_large` bounces: /3m@2d's ragged 95 MB plan). Gaps at a
    # tier's smallest rung need raw/cross-tier ingest — those stay with
    # the CFW (it self-heals them within its budgets).
    smallest = {t.name: t.shards[0] for t in pyramid.tiers}
    ext_gaps = [g for g in gaps if g.shard_dur != smallest[g.tier]]
    err(f"fillable gaps: {len(ext_gaps)} of {len(gaps)} total missing")
    if dry_run:
        for g in ext_gaps[:40]:
            err(f"  would fill /{g.tier}@{g.shard_dur} {g.period_start.date()}")
        return []

    r2 = r2_client()
    t0 = _time.time()
    results: list[MaterializeResult] = []
    for g in ext_gaps:
        if fill_limit is not None and len(results) >= fill_limit:
            err(f"  hit fill limit {fill_limit}; stopping")
            break
        if time_budget_s is not None and _time.time() - t0 > time_budget_s:
            err(f"  hit time budget {time_budget_s:.0f}s; stopping")
            break
        res = materialize_extension_shard(
            r2, pyramid, g, key_set=existing, rg_size=rg_size_for(rg_sizes, g.tier))
        results.append(res)
        if res.status == 'wrote' and register:
            from .d1_http import register_shard
            register_shard(
                pyramid=pyramid_name, tier=g.tier, shard_dur=g.shard_dur,
                period_start_ms=int(g.period_start.timestamp() * 1000),
                period_end_ms=int(g.period_end.timestamp() * 1000),
                key=g.key,
                written_at_ms=int(_time.time() * 1000),
            )
    by_status: dict[str, int] = {}
    for r in results:
        by_status[r.status] = by_status.get(r.status, 0) + 1
    err(f"extension fill: {by_status or 'nothing to do'}")
    return results
