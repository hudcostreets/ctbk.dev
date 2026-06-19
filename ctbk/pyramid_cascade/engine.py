"""Per-block cascade engine.

Streams a date-range slice of base-tier source rows once, emits all
derived tiers' shards via Polars groupby (vectorized histogram-sum).

For each output tier T:
  1. dt_out = _bin_floor(t.bin, dt_in)
  2. groupby (s2_cell, dt_out, metric, state).sum(count)   # via long format
  3. pivot back to wide: (s2_cell, dt_out, *metric:hist_json)
  4. write per output-shard period

Each output shard is either:
  - FULLY OWNED by the block (block_range covers the whole shard period) → write to final R2 path
  - PARTIAL (shard period straddles block boundary) → write to staging prefix

Caller (orchestrator) then runs the reduce phase over partials.
"""
from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Iterator

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
from pyrmts import (
    Pyramid,
    Tier,
    floor_to_span,
    parse_duration,
    shard_periods_covering,
    substitute_key,
)
from pyrmts.axis import ShardPeriod

from .config import DEFAULT_RG_SIZE, rg_size_for

# Ingester contract: (block_range) → LazyFrame of base-tier rows.
# Schema: (s2_cell: str, dt: i64 unix ms, <metric>: str — histogram JSON, ...)
Ingester = Callable[[datetime, datetime], pl.LazyFrame]


@dataclass
class ShardWriteSet:
    """Outcome of one block's cascade run.

    `finals`: keys written to the final R2 path (fully-owned shards).
    `partials`: (tier, period_label, staging_key) for shards needing reduce.
    """
    finals: list[str] = field(default_factory=list)
    partials: list[tuple[str, str, str]] = field(default_factory=list)
    empty: list[tuple[str, str]] = field(default_factory=list)


def cascade_block(
    pyramid: Pyramid,
    block_range: tuple[datetime, datetime],
    ingester: Ingester,
    *,
    staging_storage=None,
    staging_key_template: str | None = None,
    base_tier: str | None = None,
    rg_sizes: dict[str, int] | None = None,
) -> ShardWriteSet:
    """Cascade one block. Streams source via `ingester`, emits all derived
    tiers' shards via Polars groupby+histogram-sum.

    Args:
        pyramid: The configured Pyramid. Outputs go to `pyramid.storage`
            for fully-owned shards.
        block_range: half-open (from, to) UTC range covered by this block.
        ingester: callable returning a LazyFrame of base-tier rows for the
            range. Schema matches the pyramid's base tier (binCol + dims +
            histogram cols).
        staging_storage: where to write partial shards. If None, partials
            go to `pyramid.storage` under `_tmp/<block_id>/<tier>/<period>...`.
        staging_key_template: override key template for staging. Defaults
            to `_tmp/<block_id>/{tier}/{period}.parquet` under main storage.
        base_tier: which tier the ingester populates. Defaults to the finest
            tier in the pyramid.
    """
    block_from, block_to = block_range
    base = pyramid.tier(base_tier) if base_tier else pyramid.tiers[0]
    derived = [t for t in pyramid.tiers if t.name != base.name]

    bin_col = pyramid.binCol
    dim_names = [d.name for d in pyramid.dims]
    metric_cols = [m.name for m in pyramid.metrics]

    # Block_id: ISO-formatted block-from in a filename-safe shape.
    block_id = _block_id(block_from, block_to)

    result = ShardWriteSet()

    # Load source ONCE — Polars LazyFrame, melt to long form, collect
    # eagerly. Subsequent per-tier work iterates this DataFrame instead of
    # rescanning the lazy source for each (tier, period).
    src_lf = ingester(block_from, block_to)
    long_lf = _melt_histograms(src_lf, bin_col, dim_names, metric_cols)
    long_df = long_lf.collect(engine='streaming')

    # For each derived tier, compute its shards.
    for tier in derived:
        for period in shard_periods_covering(block_from, block_to, tier.shard):
            # Clamp the period to our block range — we only emit rows in
            # the intersection. If period extends past block_to, this is a
            # partial.
            seg_from = max(period.start, block_from)
            seg_to = min(period.end, block_to)
            if seg_from >= seg_to:
                continue

            partial = (period.start < block_from) or (period.end > block_to)

            shard_df = _build_tier_shard(
                long_df,
                tier=tier,
                bin_col=bin_col,
                dim_names=dim_names,
                metric_cols=metric_cols,
                seg_from=seg_from,
                seg_to=seg_to,
            )

            if shard_df.is_empty():
                result.empty.append((tier.name, period.label))
                continue

            buf = io.BytesIO()
            # Convert to PyArrow Table for parquet writing with our existing
            # row-group + compression conventions.
            table = shard_df.to_arrow()
            # Sort by (s2_cell, dt) for RG-prune-friendly layout.
            sort_cols = dim_names + [bin_col]
            table = table.sort_by([(c, 'ascending') for c in sort_cols if c in table.column_names])
            pq.write_table(table, buf,
                row_group_size=rg_size_for(rg_sizes, tier.name),
                compression='snappy')
            data = buf.getvalue()

            if not partial:
                key = substitute_key(
                    pyramid.keyTemplate,
                    {'tier': tier.name, 'period': period.label},
                )
                pyramid.storage.put(key, data)
                result.finals.append(key)
            else:
                staging_tmpl = staging_key_template or f"_tmp/{block_id}/{{tier}}/{{period}}.parquet"
                staging_key = substitute_key(
                    staging_tmpl,
                    {'tier': tier.name, 'period': period.label, 'block_id': block_id},
                )
                target_storage = staging_storage or pyramid.storage
                target_storage.put(staging_key, data)
                result.partials.append((tier.name, period.label, staging_key))

    return result


def _melt_histograms(
    src: pl.LazyFrame,
    bin_col: str,
    dim_names: list[str],
    metric_cols: list[str],
) -> pl.LazyFrame:
    """Pivot wide-histogram rows to long format: one row per
    (s2_cell, dt, metric, state) with `count` column.

    Source schema: (bin_col, *dim_names, metric_1: hist_json, metric_2: hist_json, ...)
    Output schema: (bin_col, *dim_names, metric: str, state: i64, count: i64)
    """
    keep = [bin_col, *dim_names]
    # Melt the metric columns into (metric_name, hist_json) rows.
    long = src.unpivot(
        on=metric_cols,
        index=keep,
        variable_name='metric',
        value_name='hist_json',
    ).filter(pl.col('hist_json').is_not_null())

    # Parse each JSON string into a {state: count} struct, then explode.
    # Polars 1.x has `str.json_decode` with explicit dtype.
    state_count_dtype = pl.List(pl.Struct([
        pl.Field('state', pl.Utf8),
        pl.Field('count', pl.Int64),
    ]))

    def _parse_hist_json(s: str) -> list[dict]:
        if not s:
            return []
        d = json.loads(s)
        return [{'state': str(k), 'count': int(v)} for k, v in d.items()]

    return (
        long.with_columns(
            pl.col('hist_json')
              .map_elements(_parse_hist_json, return_dtype=state_count_dtype)
              .alias('state_counts')
        )
        .drop('hist_json')
        .explode('state_counts')
        .filter(pl.col('state_counts').is_not_null())
        .with_columns([
            pl.col('state_counts').struct.field('state').cast(pl.Int64).alias('state'),
            pl.col('state_counts').struct.field('count').alias('count'),
        ])
        .drop('state_counts')
    )


def _build_tier_shard(
    long: pl.DataFrame,
    *,
    tier: Tier,
    bin_col: str,
    dim_names: list[str],
    metric_cols: list[str],
    seg_from: datetime,
    seg_to: datetime,
) -> pl.DataFrame:
    """Filter long-form rows to [seg_from, seg_to), bucket by tier.bin,
    sum counts per (*dims, dt_out, metric, state), then pivot back to wide.

    Operates on a `pl.DataFrame` (collected once per block) so per-tier
    work doesn't re-scan the lazy source.
    """
    bin_span = parse_duration(tier.bin)
    seg_from_ms = int(seg_from.timestamp() * 1000)
    seg_to_ms = int(seg_to.timestamp() * 1000)

    # Bucket by tier.bin — floor each row's dt to the tier-bin boundary.
    # Calendar bins need a Python-side floor; fixed-duration bins can use
    # integer arithmetic.
    seg = long.filter(
        (pl.col(bin_col) >= seg_from_ms) & (pl.col(bin_col) < seg_to_ms)
    )
    if seg.is_empty():
        return seg.select([
            *(pl.lit(None, dtype=pl.Utf8).alias(d) for d in dim_names),
            pl.lit(None, dtype=pl.Int64).alias(bin_col),
            *(pl.lit(None, dtype=pl.Utf8).alias(m) for m in metric_cols),
        ]).head(0)

    if bin_span.unit in ('mo', 'y'):
        def _floor_calendar(dt_ms: int) -> int:
            ts = datetime.fromtimestamp(dt_ms / 1000, tz=timezone.utc)
            return int(floor_to_span(ts, bin_span).timestamp() * 1000)
        bucketed = seg.with_columns(
            pl.col(bin_col).map_elements(_floor_calendar, return_dtype=pl.Int64).alias('dt_out')
        )
    else:
        bin_ms = bin_span.count * _unit_ms(bin_span.unit)
        bucketed = seg.with_columns(
            (pl.col(bin_col) // bin_ms * bin_ms).alias('dt_out')
        )

    # groupby (*dims, dt_out, metric, state).sum(count)
    group_cols = dim_names + ['dt_out', 'metric', 'state']
    summed = bucketed.group_by(group_cols).agg(pl.col('count').sum())

    # Rebuild per-metric hist JSON via struct-list group_by.
    per_metric = (
        summed
        .sort(['state'])  # stable order inside each hist
        .group_by(dim_names + ['dt_out', 'metric'])
        .agg(
            pl.struct(['state', 'count']).alias('hist')
        )
        .with_columns(
            pl.col('hist').map_elements(
                lambda lst: json.dumps({int(d['state']): int(d['count']) for d in lst},
                                       separators=(',', ':')),
                return_dtype=pl.Utf8,
            ).alias('hist_json')
        )
        .drop('hist')
    )

    # Final pivot to wide: (*dims, dt_out) → one row with N hist_json cols.
    pivoted = per_metric.pivot(
        on='metric',
        index=dim_names + ['dt_out'],
        values='hist_json',
    ).rename({'dt_out': bin_col})

    # Ensure every metric column exists (Polars pivot drops missing metrics).
    missing = [m for m in metric_cols if m not in pivoted.columns]
    if missing:
        pivoted = pivoted.with_columns([pl.lit(None, dtype=pl.Utf8).alias(m) for m in missing])

    # Column order: (*dims, bin_col, *metric_cols)
    return pivoted.select(dim_names + [bin_col] + metric_cols)


def _unit_ms(unit: str) -> int:
    """Convert a pyrmts ParsedTimeSpan unit to milliseconds.

    Only defined for fixed-duration units (`min`, `h`, `d`). Calendar units
    (`mo`, `y`) are variable-length and handled via `floor_to_span`.
    """
    return {'min': 60_000, 'h': 3_600_000, 'd': 86_400_000}[unit]


def _block_id(block_from: datetime, block_to: datetime) -> str:
    """Filesystem-safe block identifier from its date range."""
    return f"{block_from.strftime('%Y%m%dT%H%M%S')}_{block_to.strftime('%Y%m%dT%H%M%S')}"
