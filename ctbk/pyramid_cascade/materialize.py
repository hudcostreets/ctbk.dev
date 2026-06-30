"""fsck Phase B: per-shard materialization.

Given a single `ExpectedShard` (tier, shard_dur, period_start,
period_end, key), produce that parquet on R2. Dispatches by case:

- `(tier='1m', shard_dur=smallest)`: read raw GBFS minute parquets via
  the existing avail ingester; output long-form rows; build wide shard
  via `engine._build_tier_shard`; write.
- `(tier='1m', shard_dur=coarser)`: read N × `/1m@prev_rung` shards
  from R2; un-pivot to long; build wide shard at the same /1m bin;
  write.
- `(tier!='1m', shard_dur=smallest)`: read N × `/1m@<source_rung>` shards
  where source_rung is the largest /1m rung dividing the target
  shard_dur (mirrors `cascade.ts`'s `pickOneMSourceRung`); un-pivot to
  long; build wide shard at the tier's coarser bin; write.
- `(tier!='1m', shard_dur=coarser)`: read N × same-tier prev-rung
  shards from R2; un-pivot to long; build wide shard at the tier's
  bin; write.

Mirrors `gbfs/cascade/src/avail3/cascade.ts`'s `writeShard` but on
`e` (Python, ProcessPool-friendly, no CFW CPU budget).

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


# ─── Wide → long ───────────────────────────────────────────────────────


def shard_to_long(r2, key: str) -> pl.DataFrame | None:
    """Read a wide avail-v3 parquet → long-form
    `(s2_cell, dt, metric, state, count)` Polars DataFrame.

    Inverse of `_build_tier_shard`'s output: each (s2_cell, dt, metric)
    row has a JSON histogram `{state: count}`; we explode that to one
    row per (state, count). Empty histograms (`{}`) and null cells
    skipped.

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

    # Un-pivot each metric column → long rows. Each cell value is a
    # JSON histogram; parse + explode.
    long_chunks: list[pl.DataFrame] = []
    for m in AVAIL_METRICS:
        if m not in df.columns:
            continue
        sub = df.select(['s2_cell', 'dt', m]).rename({m: 'hist_json'}).filter(
            pl.col('hist_json').is_not_null() & (pl.col('hist_json') != '{}')
        )
        if sub.is_empty():
            continue
        # Parse JSON: returns Map[String, Int64]; convert to list of structs.
        parsed = sub.with_columns(
            pl.col('hist_json').str.json_decode(
                dtype=pl.Struct,  # let polars infer
                infer_schema_length=100,
            ).alias('hist_struct')
        ).drop('hist_json')
        # Polars struct of {state_str: count}. To go long, melt the
        # struct fields. struct.unnest then unpivot.
        unnested = parsed.unnest('hist_struct')
        state_cols = [c for c in unnested.columns if c not in ('s2_cell', 'dt')]
        if not state_cols:
            continue
        melted = unnested.unpivot(
            on=state_cols,
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


def source_long_for_gap(
    r2,
    pyramid: Pyramid,
    gap: ExpectedShard,
) -> tuple[pl.DataFrame, int, int]:
    """Return (long_df, inputs_present, inputs_expected) for the source
    reads of `gap`. Inputs-missing means some prior tier hasn't filled
    yet — caller decides whether to error / skip / partial-write."""
    shard_min = dur_min(gap.shard_dur)
    tier = pyramid.tier(gap.tier)
    tier_shards = list(tier.shards)
    smallest_dur = tier_shards[0]

    # Case 1: /1m smallest rung → read raw GBFS minutes.
    if gap.tier == '1m' and gap.shard_dur == smallest_dur:
        from .avail_ingester import avail_ingest_1m
        # avail_ingest_1m enumerates minute keys [from, to); fetches in
        # parallel; returns lazy long-form. Treat result as the source.
        long_lf = avail_ingest_1m(gap.period_start, gap.period_end)
        long = long_lf.collect(engine='streaming')
        # We don't know exact inputsPresent here without re-counting raw
        # reads; use the row-count as a coarse proxy for "got data."
        return long, (1 if not long.is_empty() else 0), 1

    # Cases 2-4: read from existing shards.
    # Determine (source_tier, source_shard_dur, N inputs).
    if gap.tier == '1m':
        # /1m coarser: read N × /1m@prev_rung from this tier.
        idx = tier_shards.index(gap.shard_dur)
        prev_dur = tier_shards[idx - 1]
        prev_min = dur_min(prev_dur)
        n_inputs = shard_min // prev_min
        source_tier = '1m'
        source_dur = prev_dur
    elif gap.shard_dur == smallest_dur:
        # Non-/1m smallest rung: read N × /1m@source from /1m.
        source_dur, source_min = pick_one_m_source_rung(pyramid, shard_min)
        n_inputs = shard_min // source_min
        source_tier = '1m'
    else:
        # Non-/1m coarser: read N × same-tier prev rung.
        idx = tier_shards.index(gap.shard_dur)
        prev_dur = tier_shards[idx - 1]
        prev_min = dur_min(prev_dur)
        n_inputs = shard_min // prev_min
        source_tier = gap.tier
        source_dur = prev_dur

    source_min = dur_min(source_dur)
    longs: list[pl.DataFrame] = []
    inputs_present = 0
    for i in range(n_inputs):
        source_start = gap.period_start + timedelta(minutes=i * source_min)
        source_key = _shard_key(pyramid, source_tier, source_dur, source_start)
        sub = shard_to_long(r2, source_key)
        if sub is None:
            continue
        if sub.is_empty():
            inputs_present += 1
            continue
        inputs_present += 1
        longs.append(sub)
    if not longs:
        empty = pl.DataFrame(
            schema={'s2_cell': pl.Utf8, 'dt': pl.Int64, 'metric': pl.Utf8,
                    'state': pl.Int64, 'count': pl.Int64},
        )
        return empty, inputs_present, n_inputs
    return pl.concat(longs, how='vertical'), inputs_present, n_inputs


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
    error: str | None = None


def materialize_shard(
    r2,
    pyramid: Pyramid,
    gap: ExpectedShard,
    *,
    rg_size: int = 2048,
    skip_existing: bool = True,
) -> MaterializeResult:
    """Build + write `gap`'s parquet. Idempotent: skips if the dst key
    already exists (HEAD check) when `skip_existing` is True (default)."""
    if skip_existing:
        try:
            r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
            return MaterializeResult(gap=gap, status='exists')
        except r2.exceptions.ClientError:
            pass

    try:
        long, inputs_present, inputs_expected = source_long_for_gap(r2, pyramid, gap)
    except Exception as e:
        return MaterializeResult(gap=gap, status='error', error=f"source: {e!r}")

    if inputs_present == 0:
        return MaterializeResult(
            gap=gap, status='no_inputs',
            inputs_present=0, inputs_expected=inputs_expected,
        )
    if long.is_empty():
        return MaterializeResult(
            gap=gap, status='empty',
            inputs_present=inputs_present, inputs_expected=inputs_expected,
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
                                 error=f"build: {e!r}")

    if wide.is_empty():
        return MaterializeResult(
            gap=gap, status='empty',
            inputs_present=inputs_present, inputs_expected=inputs_expected,
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
