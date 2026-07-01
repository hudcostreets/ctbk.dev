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

from ctbk.avail_v3 import AVAIL_METRICS, R2_BUCKET, r2_client
from utz import err


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

    Walks `enumerate_source_candidates(gap)` and picks the first
    candidate whose keys are all present on R2. If no candidate is
    fully populated, RECURSIVELY MATERIALIZES the smallest-N candidate's
    missing shards (bounded by `MAX_RECURSION_DEPTH`) before retrying.
    Falls all the way through to `/1m` if recursion exhausts. `/1m` gaps
    themselves read raw GBFS minutes via `avail_ingest_1m`.

    Recursive intermediates get their own MaterializeResult appended to
    `sub_results` so they participate in D1 emit; their R2 keys are
    added to `key_set` (whatever their terminal status — even
    `no_inputs`/`empty` intermediates count as "handled" so the parent's
    read loop can proceed and just skip the missing keys naturally).

    Each source shard is pre-aggregated to the target tier's bin
    before concatenation — bounds peak memory to O(target-bins × cells
    × metrics × states) rather than O(N × source rows).
    """
    if gap.tier == '1m':
        from .avail_ingester import avail_ingest_1m
        long_lf = avail_ingest_1m(gap.period_start, gap.period_end)
        long = long_lf.collect(engine='streaming')
        # `inputs_present` is a coarse proxy: data found ⇒ at least one
        # raw minute hit. The avail_ingester swallows per-minute 404s.
        return long, (1 if not long.is_empty() else 0), 1, 'raw'

    target_bin = pyramid.tier(gap.tier).bin
    candidates = [c for c in enumerate_source_candidates(pyramid, gap)
                  if c.n_inputs <= MAX_CANDIDATE_INPUTS]

    chosen: SourceCandidate | None = None
    for cand in candidates:
        ok, _ = _all_keys_exist(r2, cand.keys, key_set=key_set)
        if ok:
            chosen = cand
            break

    # No existing candidate — recursively materialize the smallest-N
    # candidate's missing shards. Each recursive call moves to strictly
    # smaller shards, so depth is bounded.
    if chosen is None and recursion_depth < MAX_RECURSION_DEPTH:
        ks = key_set if key_set is not None else set()
        for cand in candidates:
            for key, start in zip(cand.keys, cand.source_starts):
                if key in ks:
                    continue
                end = start + timedelta(minutes=cand.shard_dur_min)
                sub_gap = ExpectedShard(
                    tier=cand.tier, shard_dur=cand.shard_dur,
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
                # Mark handled regardless of terminal status. `wrote`/`exists`
                # put a real parquet on R2; `no_inputs`/`empty` don't, but
                # the parent read loop skips missing keys gracefully. We
                # only skip marking on `error` so we don't wedge on genuine
                # failures.
                if sub_result.status in ('wrote', 'exists', 'empty', 'no_inputs'):
                    ks.add(key)
            # Retry — the candidate may now be usable
            ok, _ = _all_keys_exist(r2, cand.keys, key_set=key_set)
            if ok:
                chosen = cand
                break

    # No fully-populated coarse-tier candidate — fall back to /1m root.
    # The fallback reads N /1m@X shards where X is the largest /1m rung
    # dividing gap.shard_dur (matches the old naive path).
    if chosen is None:
        one_m_shards = pyramid.tier('1m').shards
        gap_min = dur_min(gap.shard_dur)
        for rd in reversed(one_m_shards):
            rm = dur_min(rd)
            if rm <= gap_min and gap_min % rm == 0:
                n = gap_min // rm
                starts = [gap.period_start + timedelta(minutes=i * rm) for i in range(n)]
                keys = [_shard_key(pyramid, '1m', rd, s) for s in starts]
                chosen = SourceCandidate(tier='1m', shard_dur=rd,
                                         shard_dur_min=rm, keys=keys,
                                         source_starts=starts)
                break
        assert chosen is not None, f"no /1m rung divides {gap_min}min"

    longs: list[pl.DataFrame] = []
    inputs_present = 0
    for key in chosen.keys:
        sub = shard_to_long(r2, key)
        if sub is None:
            continue
        if sub.is_empty():
            inputs_present += 1
            continue
        inputs_present += 1
        longs.append(_preaggregate_to_tier_bin(sub, target_bin))
    source_desc = f"/{chosen.tier}@{chosen.shard_dur}×{chosen.n_inputs}"
    if not longs:
        empty = pl.DataFrame(
            schema={'s2_cell': pl.Utf8, 'dt': pl.Int64, 'metric': pl.Utf8,
                    'state': pl.Int64, 'count': pl.Int64},
        )
        return empty, inputs_present, chosen.n_inputs, source_desc
    return pl.concat(longs, how='vertical'), inputs_present, chosen.n_inputs, source_desc


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
    if skip_existing:
        if key_set is not None:
            if gap.key in key_set:
                return MaterializeResult(gap=gap, status='exists')
        else:
            try:
                r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
                return MaterializeResult(gap=gap, status='exists')
            except r2.exceptions.ClientError:
                pass

    try:
        long, inputs_present, inputs_expected, source_desc = source_long_for_gap(
            r2, pyramid, gap, key_set=key_set,
            recursion_depth=recursion_depth,
            sub_results=sub_results,
        )
    except Exception as e:
        return MaterializeResult(gap=gap, status='error', error=f"source: {e!r}")

    if inputs_present == 0:
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )
    if long.is_empty():
        return MaterializeResult(
            gap=gap, status='empty',
            inputs_present=inputs_present, inputs_expected=inputs_expected,
            source_desc=source_desc,
        )

    # Build the wide shard via the existing engine primitive.
    from .engine import _build_tier_shard
    from pyrmts import Tier
    tier_obj: Tier = pyramid.tier(gap.tier)
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
        return MaterializeResult(gap=gap, status='error',
                                 inputs_present=inputs_present,
                                 inputs_expected=inputs_expected,
                                 source_desc=source_desc,
                                 error=f"build: {e!r}")

    if wide.is_empty():
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
    r2.put_object(Bucket=R2_BUCKET, Key=gap.key, Body=blob)

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
