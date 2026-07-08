"""fsck Phase B: per-shard materialization.

Given a single `ExpectedShard` (tier, shard_dur, period_start,
period_end, key), produce that parquet on R2. Source selection walks
this priority chain (each candidate is checked for R2 existence and
the first one where ALL N shards exist is used):

1. **Within-tier prev-rung**: for `/1h@60d`, try `/1h@30d ×2`, then
   `/1h@10d ×6`, etc. Cheapest — source dt is already at target-tier
   bin granularity, so pre-aggregate is a no-op sum.
2. **Prev-tier max divisor rung**: for `/1h@60d`, `/30m@30d ×2` (bin
   requires re-flooring to 1h). Falls through prev-tier rungs
   largest-first, then prev-prev-tier, etc.
3. **`/1m` fallback**: read N × `/1m@X` (largest divisor rung of `/1m`).
   The historic naive path — many small reads, expensive.

Mirrors the SPIRIT of `gbfs/cascade/src/avail3/cascade.ts`'s
`writeShard`, but fsck's fill sees ladder gaps at multiple rungs and
must handle missing prev-rungs by falling back — the CFW's steady-state
tick can always assume the immediately-prev rung was written on the
same tick.

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

from ctbk.avail_v3 import AVAIL_GENESIS, AVAIL_METRICS, R2_BUCKET, r2_client
from time import time
from utz import err as _err
from functools import partial

err = partial(_err, flush=True)


UNIT_MIN = {'min': 1, 'h': 60, 'd': 1440, 'mo': 1440 * 30, 'y': 1440 * 365}


def dur_min(d: str) -> int:
    """Pyrmts Duration string → minutes."""
    p = parse_duration(d)
    return p.count * UNIT_MIN[p.unit]


def pick_one_m_source_rung(pyramid: Pyramid, shard_dur_min: int) -> tuple[str, int]:
    """Mirror of `cascade.ts:pickOneMSourceRung`. Returns (`Duration`,
    minutes) of the largest /1m rung that divides `shard_dur_min`."""
    one_m_shards = pyramid.tier('1m').shards
    for rung_dur in reversed(one_m_shards):
        rung_min = dur_min(rung_dur)
        if rung_min <= shard_dur_min and shard_dur_min % rung_min == 0:
            return rung_dur, rung_min
    raise ValueError(f"no /1m rung divides {shard_dur_min}min")


@dataclass
class SourceCandidate:
    """A concrete source-shard set that could feed a materialize job."""
    tier: str
    shard_dur: str
    shard_dur_min: int
    keys: list[str]  # N absolute R2 keys (partitions of gap.period_start..period_end)
    source_starts: list[datetime]

    @property
    def n_inputs(self) -> int:
        return len(self.keys)


def enumerate_source_candidates(
    pyramid: Pyramid,
    gap: ExpectedShard,
) -> list[SourceCandidate]:
    """Priority-ordered list of source-shard candidates for `gap`. See
    module docstring. Only strictly-smaller rungs that cleanly divide
    the gap's shard duration are eligible. The caller HEAD-checks each
    candidate and picks the first one where every key is present on R2.

    Candidates within a tier are largest-rung-first (cheapest reads);
    tier order is target-tier first (finest chain), then previous tiers
    largest-first, ending at `/1m`.
    """
    gap_min = dur_min(gap.shard_dur)
    gap_tier = pyramid.tier(gap.tier)
    tier_idx = next(i for i, t in enumerate(pyramid.tiers) if t.name == gap.tier)

    def rungs_for_tier(tier, allow_equal: bool) -> list[tuple[str, int]]:
        """Rungs of `tier` that divide gap_min. Largest first. When
        allow_equal=False (within-target-tier), require strictly smaller
        so we don't infinite-loop pulling a copy of ourselves."""
        out = []
        for rd in reversed(tier.shards):
            rm = dur_min(rd)
            if (rm >= gap_min) if not allow_equal else (rm > gap_min):
                continue
            if gap_min % rm != 0:
                continue
            out.append((rd, rm))
        return out

    def build_candidate(tier_name: str, rd: str, rm: int) -> SourceCandidate:
        n = gap_min // rm
        starts = [gap.period_start + timedelta(minutes=i * rm) for i in range(n)]
        keys = [_shard_key(pyramid, tier_name, rd, s) for s in starts]
        return SourceCandidate(tier=tier_name, shard_dur=rd,
                               shard_dur_min=rm, keys=keys, source_starts=starts)

    out: list[SourceCandidate] = []
    # 1. Within-target-tier prev rungs (strictly smaller)
    for rd, rm in rungs_for_tier(gap_tier, allow_equal=False):
        out.append(build_candidate(gap_tier.name, rd, rm))
    # 2. Previous tiers, coarsest-to-finest (i.e. /30m before /15m before /10m
    #    when target is /1h) — coarser previous tiers mean fewer/larger reads.
    for prev_idx in range(tier_idx - 1, -1, -1):
        prev_tier = pyramid.tiers[prev_idx]
        for rd, rm in rungs_for_tier(prev_tier, allow_equal=True):
            out.append(build_candidate(prev_tier.name, rd, rm))
    return out


def _all_keys_exist(r2, keys: list[str], key_set: set[str] | None = None) -> tuple[bool, int]:
    """Check `keys` for existence; return (all_present, present_count).

    If `key_set` (a pre-fetched snapshot of R2 keys) is provided, checks
    are pure in-memory (O(1) per key). Otherwise falls back to a
    threadpooled HEAD-per-key round-trip.

    In-memory checks against the fsck-time R2 listing are safe as
    long as the fill loop updates `key_set` whenever a new shard is
    written — see `fill_gaps` for the update pattern."""
    if key_set is not None:
        present = sum(1 for k in keys if k in key_set)
        return present == len(keys), present
    from concurrent.futures import ThreadPoolExecutor
    def check(k: str) -> bool:
        try:
            r2.head_object(Bucket=R2_BUCKET, Key=k)
            return True
        except r2.exceptions.ClientError:
            return False
    with ThreadPoolExecutor(max_workers=min(32, max(4, len(keys)))) as pool:
        results = list(pool.map(check, keys))
    present = sum(1 for r in results if r)
    return present == len(keys), present


# Maximum N-inputs to accept for a prev-rung/prev-tier candidate. Bigger
# candidates (e.g. /1h@3h × 480) are pathological — even if they were
# fully populated, the download cost would beat the /1m fallback. This
# also bounds the HEAD-check fanout when candidates aren't populated.
MAX_CANDIDATE_INPUTS = 60

# Recursion cap when materializing missing prev-rung intermediates.
# Practical depth for the 15-tier avail-v3 ladder is <= 8 (each recursion
# moves to a strictly smaller shard, and there are ~7 rungs per tier); 15
# leaves headroom. See specs/avail-v3-fsck-recursive-intermediates.md.
MAX_RECURSION_DEPTH = 15


# ─── Heterogeneous cover planning ──────────────────────────────────────


@dataclass
class SourcePick:
    """A single R2 shard contributing to a heterogeneous source cover.
    Multiple picks with different (tier, shard_dur) can compose a gap's
    source cover — see `plan_source_cover`."""
    tier: str
    shard_dur: str
    shard_dur_min: int
    period_start: datetime
    period_end: datetime  # exclusive
    key: str


def _priority_rung_pairs(
    pyramid: Pyramid, gap: ExpectedShard,
) -> list[tuple[str, str, int]]:
    """(tier, rung, rung_min) tuples in preference order:
      1. Within-target-tier smaller rungs, largest→smallest
      2. Previous tiers (coarsest→finest), each rung largest→smallest
    Only rungs strictly smaller than gap.shard_dur are considered.

    Cross-tier candidates additionally require `source_bin | target_bin`
    (source tier's bin evenly divides the target tier's bin). Without
    this, `_preaggregate_to_tier_bin`'s floor-then-groupby produces
    misaligned counts (e.g. /2m bin doesn't tile /3m bin — half of the
    /2m@0:02 bucket belongs in /3m@[0:00,0:03), the other half in
    /3m@[0:03,0:06), but floor(dt,3min) sends the whole bucket to the
    former). Same-tier candidates share bins so this doesn't apply."""
    gap_min = dur_min(gap.shard_dur)
    gap_tier_obj = pyramid.tier(gap.tier)
    target_bin_min = dur_min(gap_tier_obj.bin)
    tier_idx = next(i for i, t in enumerate(pyramid.tiers) if t.name == gap.tier)
    out: list[tuple[str, str, int]] = []
    for rd in reversed(gap_tier_obj.shards):
        rm = dur_min(rd)
        if rm >= gap_min:
            continue
        out.append((gap_tier_obj.name, rd, rm))
    for prev_idx in range(tier_idx - 1, -1, -1):
        prev_tier = pyramid.tiers[prev_idx]
        prev_bin_min = dur_min(prev_tier.bin)
        if target_bin_min % prev_bin_min != 0:
            continue  # non-divisible bin — silent-corruption trap
        for rd in reversed(prev_tier.shards):
            rm = dur_min(rd)
            if rm > gap_min:
                continue
            out.append((prev_tier.name, rd, rm))
    return out


def plan_source_cover(
    pyramid: Pyramid,
    gap: ExpectedShard,
    key_set: set[str],
) -> tuple[list[SourcePick], list[tuple[datetime, datetime]]]:
    """Heterogeneous cover of `gap.period_start..gap.period_end` using
    only shards present in `key_set`. Returns (picks, uncovered_segments).

    Algorithm:
      1. Iterate (tier, rung) pairs in priority order (coarser-tier
         largest-rung first).
      2. For each pair, sweep rung-aligned positions inside the gap
         period. When a shard exists AND doesn't overlap prior picks,
         claim it.
      3. After all pairs, compute uncovered segments as the gaps
         between consecutive claimed picks.

    Not applicable to `/1m` gaps — those use the raw ingester directly.
    """
    from pyrmts.axis import add_span, floor_to_span
    assert gap.tier != '1m', "plan_source_cover doesn't apply to /1m gaps"

    priority_pairs = _priority_rung_pairs(pyramid, gap)
    picks: list[SourcePick] = []
    # Sorted list of (period_start, period_end) tuples for claimed picks.
    covered: list[tuple[datetime, datetime]] = []

    def _overlaps(a: datetime, b: datetime) -> bool:
        # Binary search would be faster but len(covered) stays small (< N shards).
        for (ca, cb) in covered:
            if ca < b and cb > a:
                return True
        return False

    for tier_name, rung, rung_min in priority_pairs:
        span = parse_duration(rung)
        cur = floor_to_span(gap.period_start, span)
        while cur < gap.period_end:
            nxt = add_span(cur, span)
            if cur >= gap.period_start and nxt <= gap.period_end and not _overlaps(cur, nxt):
                key = _shard_key(pyramid, tier_name, rung, cur)
                if key in key_set:
                    picks.append(SourcePick(
                        tier=tier_name, shard_dur=rung, shard_dur_min=rung_min,
                        period_start=cur, period_end=nxt, key=key,
                    ))
                    covered.append((cur, nxt))
                    covered.sort(key=lambda x: x[0])
            cur = nxt

    picks.sort(key=lambda p: p.period_start)
    uncovered: list[tuple[datetime, datetime]] = []
    cur = gap.period_start
    for p in picks:
        if p.period_start > cur:
            uncovered.append((cur, p.period_start))
        cur = max(cur, p.period_end)
    if cur < gap.period_end:
        uncovered.append((cur, gap.period_end))
    return picks, uncovered


def _one_m_picks_for_segment(
    pyramid: Pyramid,
    seg_from: datetime,
    seg_to: datetime,
) -> list[SourcePick]:
    """Emit `/1m@X` picks covering [seg_from, seg_to). Uses the largest
    `/1m` rung that divides the segment and aligns to seg_from; falls
    back to the smallest `/1m` rung tiled sequentially if nothing fits
    cleanly."""
    from pyrmts.axis import floor_to_span
    one_m_shards = pyramid.tier('1m').shards
    seg_min = int((seg_to - seg_from).total_seconds() / 60)
    for rd in reversed(one_m_shards):
        rm = dur_min(rd)
        if rm > seg_min or seg_min % rm != 0:
            continue
        span = parse_duration(rd)
        if floor_to_span(seg_from, span) != seg_from:
            continue
        n = seg_min // rm
        picks = []
        for i in range(n):
            start = seg_from + timedelta(minutes=i * rm)
            end = start + timedelta(minutes=rm)
            key = _shard_key(pyramid, '1m', rd, start)
            picks.append(SourcePick(
                tier='1m', shard_dur=rd, shard_dur_min=rm,
                period_start=start, period_end=end, key=key,
            ))
        return picks
    # No clean divisor — tile with smallest /1m rung, letting the last
    # bin overhang past seg_to (harmless: filter clamps to seg range).
    smallest = one_m_shards[0]
    rm = dur_min(smallest)
    picks = []
    cur = seg_from
    while cur < seg_to:
        end = min(cur + timedelta(minutes=rm), seg_to)
        key = _shard_key(pyramid, '1m', smallest, cur)
        picks.append(SourcePick(
            tier='1m', shard_dur=smallest, shard_dur_min=rm,
            period_start=cur, period_end=end, key=key,
        ))
        cur = end
    return picks


def _summarize_picks(picks: list[SourcePick]) -> str:
    """Compact human string of a heterogeneous pick list.
    E.g. `/30m@30d×1+/1m@1d×110` for a straddling-cutoff cover."""
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
    recursion_depth: int = 0,
    sub_results: list | None = None,
) -> tuple[pl.DataFrame, int, int, str]:
    """Return `(long_df, inputs_present, inputs_expected, source_desc)`
    for the source reads of `gap`.

    Uses `plan_source_cover` to build a heterogeneous cover of the gap
    period using existing R2 shards (largest-rung-first). Uncovered
    sub-segments are:
      1. Recursively materialized (bounded by `MAX_RECURSION_DEPTH`) —
         each uncovered segment becomes a sub-gap whose own
         `materialize_shard` figures out its sources.
      2. Failing that, filled with `/1m@X` picks.

    Both `wrote`/`exists`/`empty`/`no_inputs` intermediates get their key
    marked in `key_set` — the parent read loop tolerates keys that don't
    actually exist on R2 (returns None → skipped).

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

    src_indent = '    ' * recursion_depth
    src_tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"

    # Step 1: heterogeneous cover from existing shards
    t_step = time()
    picks, uncovered = plan_source_cover(pyramid, eff_gap, ks)
    err(f"  {src_indent}  {src_tag} step1 plan_source_cover: {len(picks)} picks, {len(uncovered)} uncovered ({time()-t_step:.1f}s)")

    # Step 2: recursively materialize uncovered segments (if depth budget).
    # For each uncovered segment we try each priority (tier, rung) pair
    # that DIVIDES the segment; if one aligns, we recursively materialize
    # each sub-shard, then re-plan the cover for that segment.
    if uncovered and recursion_depth < MAX_RECURSION_DEPTH:
        from pyrmts.axis import floor_to_span
        new_uncovered: list[tuple[datetime, datetime]] = []
        priority_pairs = _priority_rung_pairs(pyramid, eff_gap)
        for (seg_from, seg_to) in uncovered:
            seg_min = int((seg_to - seg_from).total_seconds() / 60)
            fit_pair: tuple[str, str, int] | None = None
            for tier_name, rung, rung_min in priority_pairs:
                if rung_min > seg_min or seg_min % rung_min != 0:
                    continue
                if rung_min > MAX_CANDIDATE_INPUTS * dur_min(pyramid.tier(tier_name).bin):
                    continue  # Coarser than a sane recursion target
                span = parse_duration(rung)
                if floor_to_span(seg_from, span) != seg_from:
                    continue
                n = seg_min // rung_min
                if n > MAX_CANDIDATE_INPUTS:
                    continue
                fit_pair = (tier_name, rung, rung_min)
                break
            if fit_pair is None:
                new_uncovered.append((seg_from, seg_to))
                continue
            tier_name, rung, rung_min = fit_pair
            n = seg_min // rung_min
            for i in range(n):
                start = seg_from + timedelta(minutes=i * rung_min)
                end = start + timedelta(minutes=rung_min)
                key = _shard_key(pyramid, tier_name, rung, start)
                if key in ks:
                    continue
                sub_gap = ExpectedShard(
                    tier=tier_name, shard_dur=rung,
                    period_start=start, period_end=end, key=key,
                )
                sub_result = materialize_shard(
                    r2, pyramid, sub_gap,
                    key_set=key_set,
                    recursion_depth=recursion_depth + 1,
                    sub_results=sub_results,
                )
                if sub_results is not None:
                    sub_results.append(sub_result)
                if sub_result.status in ('wrote', 'exists', 'empty', 'no_inputs'):
                    ks.add(key)
        # Re-plan cover after recursive fills
        t_step = time()
        picks2, uncovered2 = plan_source_cover(pyramid, eff_gap, ks)
        err(f"  {src_indent}  {src_tag} step2 re-plan: {len(picks2)} picks, {len(uncovered2)} uncovered, {len(new_uncovered)} left-uncovered ({time()-t_step:.1f}s)")
        picks = picks2
        uncovered = uncovered2 + new_uncovered

    # Step 3: /1m fallback for anything still uncovered
    if uncovered:
        t_step = time()
        pre = len(picks)
        for (seg_from, seg_to) in uncovered:
            picks.extend(_one_m_picks_for_segment(pyramid, seg_from, seg_to))
        err(f"  {src_indent}  {src_tag} step3 /1m fallback: {len(picks) - pre} extra picks for {len(uncovered)} uncovered segs ({time()-t_step:.1f}s)")

    longs: list[pl.DataFrame] = []
    inputs_present = 0
    t_reads = time()
    err(f"  {src_indent}  {src_tag} reading {len(picks)} picks...")
    for i, pick in enumerate(picks):
        t_pick = time()
        sub = shard_to_long(r2, pick.key)
        if sub is None:
            err(f"  {src_indent}    [{i+1}/{len(picks)}] {pick.key} → missing ({time()-t_pick:.1f}s)")
            continue
        if sub.is_empty():
            inputs_present += 1
            err(f"  {src_indent}    [{i+1}/{len(picks)}] {pick.key} → empty ({time()-t_pick:.1f}s)")
            continue
        inputs_present += 1
        pre_rows = sub.height
        agg = _preaggregate_to_tier_bin(sub, target_bin)
        longs.append(agg)
        err(f"  {src_indent}    [{i+1}/{len(picks)}] {pick.key} → {pre_rows:,}→{agg.height:,} rows ({time()-t_pick:.1f}s)")
    err(f"  {src_indent}  {src_tag} reads done: {inputs_present}/{len(picks)} present ({time()-t_reads:.1f}s)")
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


@dataclass
class MaterializeResult:
    gap: ExpectedShard
    status: str   # 'wrote' / 'exists' / 'no_inputs' / 'empty' / 'error'
    bytes_written: int = 0
    rows: int = 0
    inputs_present: int = 0
    inputs_expected: int = 0
    source_desc: str = ''  # e.g. '/1h@30d×2', '/1m@1d×60', 'raw'
    error: str | None = None


def materialize_shard(
    r2,
    pyramid: Pyramid,
    gap: ExpectedShard,
    *,
    rg_size: int = 2048,
    skip_existing: bool = True,
    key_set: set[str] | None = None,
    recursion_depth: int = 0,
    sub_results: list | None = None,
) -> MaterializeResult:
    """Build + write `gap`'s parquet. Idempotent: skips if the dst key
    already exists (checked in `key_set` if provided, else via HEAD)
    when `skip_existing` is True (default).

    `recursion_depth` / `sub_results` support recursive intermediate
    materialization — see `source_long_for_gap`."""
    indent = '    ' * recursion_depth
    tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"
    t0 = time()
    if skip_existing:
        if key_set is not None:
            if gap.key in key_set:
                err(f"  {indent}⟶ {tag} → exists (cached)")
                return MaterializeResult(gap=gap, status='exists')
        else:
            try:
                r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
                err(f"  {indent}⟶ {tag} → exists (HEAD)")
                return MaterializeResult(gap=gap, status='exists')
            except r2.exceptions.ClientError:
                pass

    if gap.period_end <= AVAIL_GENESIS:
        err(f"  {indent}⟶ {tag} → no_inputs (pre-genesis)")
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=0,
            source_desc='pre-genesis',
        )

    err(f"  {indent}⟶ {tag} → START (depth={recursion_depth})")
    try:
        long, inputs_present, inputs_expected, source_desc = source_long_for_gap(
            r2, pyramid, gap, key_set=key_set,
            recursion_depth=recursion_depth,
            sub_results=sub_results,
        )
    except Exception as e:
        err(f"  {indent}⟵ {tag} → ERROR source: {e!r} ({time()-t0:.1f}s)")
        return MaterializeResult(gap=gap, status='error', error=f"source: {e!r}")

    err(f"  {indent}  {tag} sourced ({source_desc}; inputs {inputs_present}/{inputs_expected}, {long.height:,} rows, {time()-t0:.1f}s)")
    if inputs_present == 0:
        err(f"  {indent}⟵ {tag} → no_inputs ({source_desc}, {time()-t0:.1f}s)")
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )
    if long.is_empty():
        err(f"  {indent}⟵ {tag} → empty ({source_desc}, {time()-t0:.1f}s)")
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
        err(f"  {indent}⟵ {tag} → ERROR build: {e!r} ({time()-t0:.1f}s)")
        return MaterializeResult(gap=gap, status='error',
                                 inputs_present=inputs_present,
                                 inputs_expected=inputs_expected,
                                 source_desc=source_desc,
                                 error=f"build: {e!r}")
    err(f"  {indent}  {tag} built ({wide.height:,} rows, {time()-t_build:.1f}s)")

    if wide.is_empty():
        err(f"  {indent}⟵ {tag} → empty (post-build, {time()-t0:.1f}s)")
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
    err(f"  {indent}⟵ {tag} → wrote ({wide.height:,} rows, {len(blob)/1e6:.1f}MB, put {time()-t_put:.1f}s, total {time()-t0:.1f}s)")

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
