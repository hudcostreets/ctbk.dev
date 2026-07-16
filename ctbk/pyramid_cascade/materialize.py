"""fsck Phase B: per-shard materialization.

Strict tier-by-tier cascade. A gap at tier N sources ONLY from tier
N-1's min-cover intersecting the gap's period. Tier N-1 is
`source_tier_for(pyramid, N)` — the largest tier T with `bin(T) <
bin(N)` AND `bin(N) % bin(T) == 0`. Divisibility guarantees the
per-source pre-aggregate to the target's bin is exact.

Tier N-1 must be complete-in-range before we materialize gaps in tier
N; enforced by `fsck.fill_gaps` sorting missing shards by (tier_idx,
shard_dur, period_start) ascending and processing tier layers
finest-first.

Tier `/1m` sources from raw WAL via `avail_ingester.avail_ingest_1m`,
as do tiers whose strict-cascade source tier IS `/1m` (reading raw is
~5x cheaper than decoding `/1m` parquets back to long form — see the
base-tier substitution in `source_long_for_gap`).

Prior versions did heterogeneous multi-tier covers with `/1m` fallback
picks that could be emitted without checking R2 existence, silently
under-populating tail segments of coarse pre-genesis-notional shards
(see specs/avail-v3-strict-cascade.md for the incident). The strict
cascade eliminates that class of bug: any uncovered segment in the
source tier is a strict-cascade invariant violation and raises.

D1 recording: this module emits R2 writes only. The driver
(`fsck.fill_gaps`) collects (tier, shard_dur, period_start, period_end,
key, bytes) records and writes an `INSERT` SQL batch for
`wrangler d1 execute --remote --file ...`.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
from pyrmts import ExpectedShard, Pyramid
from pyrmts.axis import parse_duration

from ctbk.avail_v3 import AVAIL_METRICS
from time import time
from utz import err as _err
from functools import partial

# Shared with the Lambda executor via the polars-free `lite` module.
from .lite import AVAIL_GENESIS, R2_BUCKET, UNIT_MIN, MaterializeResult, dur_min, r2_client

err = partial(_err, flush=True)


def source_tier_for(pyramid: Pyramid, tier_name: str):
    """Strict-cascade source tier: the largest tier T' with
    `bin(T') < bin(tier_name)` AND `bin(tier_name) % bin(T') == 0`.

    Bin divisibility is required so `_preaggregate_to_tier_bin`'s
    floor-then-groupby produces exact aggregates (misaligned bins send
    half a source bucket into the wrong target bucket).

    Ties (multiple candidates with the same bin) never occur — each
    tier has a unique bin. Returns `None` for `/1m` (raw-ingest source).
    Raises for any other tier without a divisor (should never happen
    in a well-formed pyramid — `/1m` must be the finest and its bin
    divides everything).
    """
    if tier_name == '1m':
        return None
    target_bin_min = dur_min(pyramid.tier(tier_name).bin)
    tier_idx = next(i for i, t in enumerate(pyramid.tiers) if t.name == tier_name)
    best = None
    best_bin_min = 0
    for i in range(tier_idx):
        cand = pyramid.tiers[i]
        cand_bin_min = dur_min(cand.bin)
        if cand_bin_min >= target_bin_min or target_bin_min % cand_bin_min != 0:
            continue
        if cand_bin_min > best_bin_min:
            best = cand
            best_bin_min = cand_bin_min
    if best is None:
        raise AssertionError(f"no source tier for /{tier_name} — pyramid ladder is malformed")
    return best


# ─── Single-tier cover planning ────────────────────────────────────────


@dataclass
class SourcePick:
    """A single source shard contributing to a gap's source cover.
    In strict cascade all picks share the same `tier` (the gap's
    source_tier); `shard_dur` may vary as `plan_source_cover_single_tier`
    picks the largest fitting rung per position."""
    tier: str
    shard_dur: str
    shard_dur_min: int
    period_start: datetime
    period_end: datetime  # exclusive
    key: str


def plan_source_cover_single_tier(
    gap: ExpectedShard,
    source_expected: list,
    key_set: set[str],
) -> tuple[list[SourcePick], list[tuple[datetime, datetime]]]:
    """Filter `source_expected` (the outer fsck's expected shards for
    source_tier over the full fsck range) to those intersecting
    `[gap.period_start, gap.period_end)`, and return picks + uncovered.

    Why not compute a fresh cover for eff_gap? Because pyrmts's
    `_cover_for_tier` picks tiles that fit strictly inside its
    (from, to) range. For a target shard whose eff_gap doesn't align
    with source_tier's outer-cover boundaries (e.g. /7d@28d wanting
    /1d for 28d but /1d's outer cover picks /1d@32d), a fresh eff_gap
    cover would ask for smaller /1d shards that were never built.

    Reading a source shard that overshoots eff_gap.period_end is safe:
    `_preaggregate_to_tier_bin` floors dt to the target's bin, and
    `_build_tier_shard`'s `dt < seg_to` filter drops the overshoot.
    Same applies to pre-eff_gap overshoot (empty pre-genesis rows).

    Uncovered segments are parts of eff_gap not touched by any
    intersecting expected shard. In the strict-cascade regime the
    caller treats uncovered as an invariant violation."""
    picks: list[SourcePick] = []
    intersecting = []
    for e in source_expected:
        # Half-open intersection: shard [ps, pe) overlaps gap [gs, ge) iff
        # ps < ge AND pe > gs.
        if e.period_start < gap.period_end and e.period_end > gap.period_start:
            intersecting.append(e)
    intersecting.sort(key=lambda e: e.period_start)

    for e in intersecting:
        if e.key in key_set:
            picks.append(SourcePick(
                tier=e.tier, shard_dur=e.shard_dur, shard_dur_min=dur_min(e.shard_dur),
                period_start=e.period_start, period_end=e.period_end, key=e.key,
            ))

    # Uncovered = parts of eff_gap not touched by any *present* intersecting
    # expected shard.
    uncovered: list[tuple[datetime, datetime]] = []
    cur = gap.period_start
    present = [e for e in intersecting if e.key in key_set]
    for e in present:
        seg_start = max(e.period_start, gap.period_start)
        if seg_start > cur:
            uncovered.append((cur, seg_start))
        cur = max(cur, min(e.period_end, gap.period_end))
    if cur < gap.period_end:
        uncovered.append((cur, gap.period_end))

    # Also treat expected-but-missing shards as uncovered (they'd have
    # matched the gap's eff_gap but the source shard doesn't exist).
    missing_expected = [e for e in intersecting if e.key not in key_set]
    for e in missing_expected:
        seg_from = max(e.period_start, gap.period_start)
        seg_to = min(e.period_end, gap.period_end)
        if seg_to > seg_from:
            uncovered.append((seg_from, seg_to))

    return picks, uncovered


def _summarize_picks(picks: list[SourcePick]) -> str:
    """Compact human string of a pick list, e.g. `/3h@32d×1+/3h@1d×26`."""
    from collections import Counter
    counts = Counter((p.tier, p.shard_dur) for p in picks)
    parts = [f"/{t}@{s}×{n}" for (t, s), n in counts.most_common()]
    return "+".join(parts) if parts else "no-source"


# ─── Wide → long ───────────────────────────────────────────────────────


# State-key cap for the explicit Struct schema passed to json_decode.
# Polars json_decode needs the full struct shape upfront; we materialize
# fields '0'..MAX_STATE_KEY and rely on null-filtering after unpivot to
# drop the unused ones. Empirical max state key observed across all
# avail-v3 histograms is 117 (large valet stations); 200 leaves headroom
# without much pivot overhead (200 nullable Int64 cols per metric).
MAX_STATE_KEY = 200
_HIST_STRUCT_SCHEMA = pl.Struct([
    pl.Field(str(i), pl.Int64) for i in range(MAX_STATE_KEY + 1)
])
_STATE_COL_NAMES = [str(i) for i in range(MAX_STATE_KEY + 1)]

# Chunk the wide→long conversion by an s2_cell hash bucket so json_decode +
# unnest + unpivot run on ~1/N of the rows at a time. The unchunked path
# OOM'd on /1m@1d shards (5.4M rows × 5 metrics × 201-field struct).
UNPIVOT_CHUNKS = 16


def shard_to_long(r2, key: str) -> pl.DataFrame | None:
    """Read a wide avail-v3 parquet → long-form
    `(s2_cell, dt, metric, state, count)` Polars DataFrame.

    Inverse of `_build_tier_shard`'s output: each (s2_cell, dt, metric)
    row has a JSON histogram `{state: count}`; we parse with an explicit
    Struct schema (`pl.Struct` without fields silently produces empty
    structs and drops every state key) and unpivot to long. Histogram
    keys above `MAX_STATE_KEY` are silently dropped — bump the cap if
    that ever fires in real data (empirical max: 117 for valet stations).

    Returns None if the key doesn't exist (404)."""
    try:
        obj = r2.get_object(Bucket=R2_BUCKET, Key=key)
    except r2.exceptions.ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    tab = pq.read_table(io.BytesIO(obj['Body'].read()))
    df = pl.from_arrow(tab)

    long_chunks: list[pl.DataFrame] = []
    df = df.with_columns(
        (pl.col('s2_cell').hash(seed=0) % UNPIVOT_CHUNKS).alias('_chunk')
    )
    for chunk in df.partition_by('_chunk', maintain_order=False):
        chunk = chunk.drop('_chunk')
        for m in AVAIL_METRICS:
            if m not in chunk.columns:
                continue
            sub = chunk.select(['s2_cell', 'dt', m]).rename({m: 'hist_json'}).filter(
                pl.col('hist_json').is_not_null() & (pl.col('hist_json') != '{}')
            )
            if sub.is_empty():
                continue
            parsed = sub.with_columns(
                pl.col('hist_json').str.json_decode(dtype=_HIST_STRUCT_SCHEMA).alias('hist_struct')
            ).drop('hist_json')
            unnested = parsed.unnest('hist_struct')
            melted = unnested.unpivot(
                on=_STATE_COL_NAMES,
                index=['s2_cell', 'dt'],
                variable_name='state_str',
                value_name='count',
            ).filter(pl.col('count').is_not_null() & (pl.col('count') > 0))
            if melted.is_empty():
                continue
            long = melted.with_columns([
                pl.lit(m).alias('metric'),
                pl.col('state_str').cast(pl.Int64).alias('state'),
            ]).select(['s2_cell', 'dt', 'metric', 'state', 'count'])
            long_chunks.append(long)

    if not long_chunks:
        return pl.DataFrame(
            schema={'s2_cell': pl.Utf8, 'dt': pl.Int64, 'metric': pl.Utf8,
                    'state': pl.Int64, 'count': pl.Int64},
        )
    return pl.concat(long_chunks, how='vertical')


# ─── Sources ───────────────────────────────────────────────────────────


def _preaggregate_to_tier_bin(long: pl.DataFrame, target_bin: str) -> pl.DataFrame:
    """Sum `long`'s rows into the target tier's coarser bin. Reduces per-
    source-shard row count before the outer concat so large N-input
    fills (e.g. /1h@60d = 60 × /1m@1d) don't OOM on concatenation.

    Reduces (s2_cell, dt_min, metric, state) → (s2_cell, dt_target,
    metric, state) with counts summed. Each source shard's rows sum
    into a disjoint set of target bins (since source_dur divides
    target-shard boundaries), so cross-source dedup happens in
    `_build_tier_shard`."""
    from pyrmts.axis import floor_to_span
    bin_span = parse_duration(target_bin)
    if bin_span.unit in ('mo', 'y'):
        def _floor_calendar(dt_ms: int) -> int:
            ts = datetime.fromtimestamp(dt_ms / 1000, tz=timezone.utc)
            return int(floor_to_span(ts, bin_span).timestamp() * 1000)
        bucketed = long.with_columns(
            pl.col('dt').map_elements(_floor_calendar, return_dtype=pl.Int64).alias('dt')
        )
    else:
        unit_ms = UNIT_MIN[bin_span.unit] * 60_000
        bin_ms = bin_span.count * unit_ms
        bucketed = long.with_columns(
            (pl.col('dt') // bin_ms * bin_ms).alias('dt')
        )
    return bucketed.group_by(['s2_cell', 'dt', 'metric', 'state']).agg(
        pl.col('count').sum()
    )


def source_long_for_gap(
    r2,
    pyramid: Pyramid,
    gap: ExpectedShard,
    *,
    key_set: set[str] | None = None,
    expected_by_tier: dict | None = None,
) -> tuple[pl.DataFrame, int, int, str]:
    """Return `(long_df, inputs_present, inputs_expected, source_desc)`
    for the source reads of `gap`.

    Strict tier-by-tier cascade: gap at tier N reads ONLY from tier N-1's
    outer-fsck expected set (intersecting eff_gap). Tier N-1 is
    `source_tier_for(pyramid, gap.tier)`. Any uncovered segment after
    the plan raises — tier N-1 must be complete-in-range before N is
    materialized (fill ordering invariant).

    `expected_by_tier` is the outer fsck's `list_expected_shards` result
    grouped by tier name. Threading it in (vs. re-computing per-gap)
    ensures the source picks are exactly the shards the outer fill order
    materializes at tier N-1, and lets us handle N-1's outer cover using
    tiles that overshoot gap.eff_gap.period_end (safely — the target
    build filters `dt < seg_to`).

    Tier `/1m` sources from raw WAL via `avail_ingest_1m`. Tiers whose
    source tier IS the base tier (2m/3m/5m under the avail ladder) also
    ingest raw — see the base-tier substitution below.

    Each source shard is pre-aggregated to the target tier's bin before
    concatenation — bounds peak memory to O(target-bins × cells × metrics
    × states) rather than O(N × source rows).
    """
    if gap.tier == '1m':
        from .avail_ingester import avail_ingest_1m
        long_lf = avail_ingest_1m(gap.period_start, gap.period_end)
        long = long_lf.collect(engine='streaming')
        # `inputs_present` is a coarse proxy: data found ⇒ at least one
        # raw minute hit. The avail_ingester swallows per-minute 404s.
        return long, (1 if not long.is_empty() else 0), 1, 'raw'

    target_bin = pyramid.tier(gap.tier).bin
    ks: set[str] = key_set if key_set is not None else set()

    # Clip the effective sourcing range to genesis. The gap's notional
    # period may extend arbitrarily far into the past for coarse trailing
    # max-shards (per `pyrmts.gap_discovery` docstring); the raw WAL only
    # exists from AVAIL_GENESIS forward, so scanning the pre-genesis
    # segment produces no data at astronomical wall-clock cost.
    if gap.period_start < AVAIL_GENESIS:
        from dataclasses import replace
        eff_gap = replace(gap, period_start=AVAIL_GENESIS)
    else:
        eff_gap = gap

    src_tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"
    src_tier = source_tier_for(pyramid, gap.tier)  # not None: /1m handled above

    if src_tier.name == pyramid.tiers[0].name:
        # Base-tier substitution: the base tier's shards are R2-parquet
        # copies of raw (same minute-grain long form), and decoding them
        # via `shard_to_long`'s JSON-histogram unpivot costs ~5x the raw
        # fetch+parse for the same window (observed 500s vs ~100s per
        # /1m@2d). Ingest raw directly, chunked by UTC day so peak memory
        # stays O(1 day of raw) regardless of gap.shard_dur. Chunks whose
        # bins straddle a boundary produce partial sums per (cell, dt,
        # metric, state) — exact after `_build_tier_shard`'s group-by sum.
        from .avail_ingester import avail_ingest_1m
        t_reads = time()
        err(f"    {src_tag} sourcing raw (base-tier substitution), 1d chunks...")
        longs: list[pl.DataFrame] = []
        chunk_from = eff_gap.period_start
        while chunk_from < eff_gap.period_end:
            next_midnight = (chunk_from + timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0,
            )
            chunk_to = min(next_midnight, eff_gap.period_end)
            sub = avail_ingest_1m(chunk_from, chunk_to).collect(engine='streaming')
            if not sub.is_empty():
                longs.append(_preaggregate_to_tier_bin(sub, target_bin))
            chunk_from = chunk_to
        err(f"    {src_tag} raw reads done ({time()-t_reads:.1f}s)")
        if not longs:
            empty = pl.DataFrame(
                schema={'s2_cell': pl.Utf8, 'dt': pl.Int64, 'metric': pl.Utf8,
                        'state': pl.Int64, 'count': pl.Int64},
            )
            return empty, 0, 1, 'raw'
        return pl.concat(longs, how='vertical'), 1, 1, 'raw'

    if expected_by_tier is None:
        # Fall-back: use pyrmts's cover of just eff_gap. Sufficient when
        # the caller isn't running full fsck (single-shard smoke tests).
        from pyrmts.gap_discovery import _cover_for_tier
        source_expected = _cover_for_tier(
            pyramid, src_tier, eff_gap.period_start, eff_gap.period_end, filter={},
        )
    else:
        source_expected = expected_by_tier.get(src_tier.name, [])

    t_step = time()
    picks, uncovered = plan_source_cover_single_tier(eff_gap, source_expected, ks)
    err(f"    {src_tag} source_plan: {len(picks)} picks from /{src_tier.name}, "
        f"{len(uncovered)} uncovered ({time()-t_step:.1f}s)")

    if uncovered:
        # Strict-cascade invariant violation: /{src_tier.name} must be
        # fully materialized in [eff_gap.period_start, eff_gap.period_end)
        # before this gap is scheduled. The fill loop's finest-first tier
        # ordering (`sort_by_dependency`) is the mechanism.
        sample = ', '.join(f"[{s.isoformat()}, {e.isoformat()})" for s, e in uncovered[:3])
        more = f" +{len(uncovered) - 3} more" if len(uncovered) > 3 else ""
        raise RuntimeError(
            f"strict-cascade invariant violation for {src_tag}: "
            f"source tier /{src_tier.name} has {len(uncovered)} uncovered segment(s): "
            f"{sample}{more}. Ensure all /{src_tier.name} shards in the range are "
            f"materialized before /{gap.tier} shards are scheduled."
        )

    longs: list[pl.DataFrame] = []
    inputs_present = 0
    t_reads = time()
    err(f"    {src_tag} reading {len(picks)} picks from /{src_tier.name}...")
    for i, pick in enumerate(picks):
        t_pick = time()
        sub = shard_to_long(r2, pick.key)
        if sub is None:
            # Should not happen — plan_source_cover_single_tier only picks
            # keys in ks. If we get here, ks lied about R2 state (write
            # was recorded but object is missing).
            err(f"      [{i+1}/{len(picks)}] {pick.key} → MISSING (ks/R2 mismatch, {time()-t_pick:.1f}s)")
            raise RuntimeError(
                f"strict-cascade read failure for {src_tag}: source pick "
                f"{pick.key} was in key_set but R2 returned 404. Either the "
                f"key_set is stale or the source shard was deleted concurrently."
            )
        if sub.is_empty():
            inputs_present += 1
            err(f"      [{i+1}/{len(picks)}] {pick.key} → empty ({time()-t_pick:.1f}s)")
            continue
        inputs_present += 1
        pre_rows = sub.height
        agg = _preaggregate_to_tier_bin(sub, target_bin)
        longs.append(agg)
        err(f"      [{i+1}/{len(picks)}] {pick.key} → {pre_rows:,}→{agg.height:,} rows ({time()-t_pick:.1f}s)")
    err(f"    {src_tag} reads done: {inputs_present}/{len(picks)} present ({time()-t_reads:.1f}s)")
    source_desc = _summarize_picks(picks)
    if not longs:
        empty = pl.DataFrame(
            schema={'s2_cell': pl.Utf8, 'dt': pl.Int64, 'metric': pl.Utf8,
                    'state': pl.Int64, 'count': pl.Int64},
        )
        return empty, inputs_present, len(picks), source_desc
    return pl.concat(longs, how='vertical'), inputs_present, len(picks), source_desc


def _shard_key(pyramid: Pyramid, tier: str, shard_dur: str, period_start: datetime) -> str:
    """Substitute the pyramid's keyTemplate for a specific shard."""
    from pyrmts.axis import format_period
    from pyrmts.keys import substitute_key
    span = parse_duration(shard_dur)
    label = format_period(period_start, span)
    return substitute_key(
        pyramid.keyTemplate,
        {'tier': tier, 'shard': shard_dur, 'period': label},
    )


# ─── Per-shard materializer ────────────────────────────────────────────


def materialize_shard(
    r2,
    pyramid: Pyramid,
    gap: ExpectedShard,
    *,
    rg_size: int = 2048,
    skip_existing: bool = True,
    key_set: set[str] | None = None,
    expected_by_tier: dict | None = None,
) -> MaterializeResult:
    """Build + write `gap`'s parquet. Idempotent: skips if the dst key
    already exists (checked in `key_set` if provided, else via HEAD)
    when `skip_existing` is True (default)."""
    tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"
    t0 = time()
    if skip_existing:
        if key_set is not None:
            if gap.key in key_set:
                err(f"  ⟶ {tag} → exists (cached)")
                return MaterializeResult(gap=gap, status='exists')
        else:
            try:
                r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
                err(f"  ⟶ {tag} → exists (HEAD)")
                return MaterializeResult(gap=gap, status='exists')
            except r2.exceptions.ClientError:
                pass

    if gap.period_end <= AVAIL_GENESIS:
        err(f"  ⟶ {tag} → no_inputs (pre-genesis)")
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=0,
            source_desc='pre-genesis',
        )

    err(f"  ⟶ {tag} → START")
    try:
        long, inputs_present, inputs_expected, source_desc = source_long_for_gap(
            r2, pyramid, gap, key_set=key_set, expected_by_tier=expected_by_tier,
        )
    except Exception as e:
        err(f"  ⟵ {tag} → ERROR source: {e!r} ({time()-t0:.1f}s)")
        return MaterializeResult(gap=gap, status='error', error=f"source: {e!r}")

    err(f"    {tag} sourced ({source_desc}; inputs {inputs_present}/{inputs_expected}, {long.height:,} rows, {time()-t0:.1f}s)")
    if inputs_present == 0:
        err(f"  ⟵ {tag} → no_inputs ({source_desc}, {time()-t0:.1f}s)")
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )
    if long.is_empty():
        err(f"  ⟵ {tag} → empty ({source_desc}, {time()-t0:.1f}s)")
        return MaterializeResult(
            gap=gap, status='empty',
            inputs_present=inputs_present, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )

    # Build the wide shard via the existing engine primitive.
    from .engine import _build_tier_shard
    from pyrmts import Tier
    tier_obj: Tier = pyramid.tier(gap.tier)
    t_build = time()
    try:
        wide = _build_tier_shard(
            long,
            tier=tier_obj,
            bin_col='dt',
            dim_names=['s2_cell'],
            metric_cols=list(AVAIL_METRICS),
            seg_from=gap.period_start,
            seg_to=gap.period_end,
        )
    except Exception as e:
        err(f"  ⟵ {tag} → ERROR build: {e!r} ({time()-t0:.1f}s)")
        return MaterializeResult(gap=gap, status='error',
                                 inputs_present=inputs_present,
                                 inputs_expected=inputs_expected,
                                 source_desc=source_desc,
                                 error=f"build: {e!r}")
    err(f"    {tag} built ({wide.height:,} rows, {time()-t_build:.1f}s)")

    if wide.is_empty():
        err(f"  ⟵ {tag} → empty (post-build, {time()-t0:.1f}s)")
        return MaterializeResult(
            gap=gap, status='empty',
            inputs_present=inputs_present, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )

    # Sort by (s2_cell, dt) for RG-prune-friendly layout (matches the
    # CFW writer + the v2 rebuild from ctbk #114).
    wide = wide.sort(['s2_cell', 'dt'])

    # Write parquet with small row groups (matches avail-v3 conventions).
    table = wide.to_arrow()
    buf = io.BytesIO()
    pq.write_table(table, buf, row_group_size=rg_size, compression='snappy')
    blob = buf.getvalue()
    t_put = time()
    r2.put_object(Bucket=R2_BUCKET, Key=gap.key, Body=blob)
    err(f"  ⟵ {tag} → wrote ({wide.height:,} rows, {len(blob)/1e6:.1f}MB, put {time()-t_put:.1f}s, total {time()-t0:.1f}s)")

    return MaterializeResult(
        gap=gap, status='wrote',
        bytes_written=len(blob),
        rows=wide.height,
        inputs_present=inputs_present,
        inputs_expected=inputs_expected,
        source_desc=source_desc,
    )


# ─── D1 INSERT SQL emission ────────────────────────────────────────────


def emit_d1_insert_sql(
    pyramid_name: str,
    results: list[MaterializeResult],
    sql_path: str,
) -> int:
    """Emit a wrangler-runnable SQL file with INSERT OR REPLACE for each
    successfully-written shard. Returns the count of rows planned.

    Schema (matches `pyrmts-cfw/src/shard-index.ts:schemaSql`):
      pyramid_shards(pyramid, tier, shard_dur, period_start, period_end, key, written_at)
      pyramid_watermarks(pyramid, tier, shard_dur, latest_period_end, updated_at)

    Both tables get INSERT … ON CONFLICT updates so re-runs are
    idempotent. `written_at`/`updated_at` use a single SQL `unixepoch()*1000`
    (D1 ts in ms — matches the CFW's `Date.now()`).

    Emits for both `'wrote'` (newly materialized) and `'exists'` (R2
    path already present, e.g. from a prior r2-copy). The `'exists'`
    case matters after the cutover-time D1 canonical-row cleanup —
    /1m..15m shards already on R2 from r2-copy need D1 rows so the api
    worker sees them. Skipping `'exists'` would leave them invisible
    until the next steady-state cron tick re-writes them."""
    eligible = [r for r in results if r.status in ('wrote', 'exists')]
    if not eligible:
        return 0
    lines: list[str] = []
    for r in eligible:
        ps = int(r.gap.period_start.timestamp() * 1000)
        pe = int(r.gap.period_end.timestamp() * 1000)
        # Single quotes inside strings: ctbk's tiers/shards/keys don't
        # contain them today; if any field ever does, the assert keeps
        # us from emitting broken SQL.
        for s in (pyramid_name, r.gap.tier, r.gap.shard_dur, r.gap.key):
            assert "'" not in s, f"single-quote in {s!r} — SQL injection guard"
        lines.append(
            f"INSERT INTO pyramid_shards "
            f"(pyramid, tier, shard_dur, period_start, period_end, key, written_at) "
            f"VALUES ('{pyramid_name}', '{r.gap.tier}', '{r.gap.shard_dur}', "
            f"{ps}, {pe}, '{r.gap.key}', unixepoch()*1000) "
            f"ON CONFLICT (pyramid, tier, shard_dur, period_start) DO UPDATE SET "
            f"period_end=excluded.period_end, key=excluded.key, written_at=excluded.written_at;"
        )
        lines.append(
            f"INSERT INTO pyramid_watermarks "
            f"(pyramid, tier, shard_dur, latest_period_end, updated_at) "
            f"VALUES ('{pyramid_name}', '{r.gap.tier}', '{r.gap.shard_dur}', "
            f"{pe}, unixepoch()*1000) "
            f"ON CONFLICT (pyramid, tier, shard_dur) DO UPDATE SET "
            f"latest_period_end=MAX(excluded.latest_period_end, pyramid_watermarks.latest_period_end), "
            f"updated_at=excluded.updated_at;"
        )
    with open(sql_path, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    err(f"emitted {len(eligible)} shard INSERTs ({len(lines)} statements) → {sql_path}")
    err(f"  run with: (cd gbfs/api && wrangler d1 execute ctbk-gbfs --remote --file {sql_path})")
    return len(eligible)
