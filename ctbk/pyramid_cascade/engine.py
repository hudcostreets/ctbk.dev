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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

import polars as pl
import pyarrow.parquet as pq
from pyrmts import (
    Pyramid,
    Tier,
    floor_to_span,
    parse_duration,
    shard_periods_covering,
    substitute_key,
)
from utz import err

from ._hist import build_hist_json_lazy as _build_hist_json
from .config import rg_size_for

# Ingester contract: (block_range) → LazyFrame of base-tier rows IN LONG FORM.
# Schema: (*dims, bin_col: i64 unix ms, metric: str, state: i64, count: i64)
# i.e. one row per (cell, dt, metric, state) with the observation count.
# JSON serialization happens only at parquet-write time, in `_build_tier_shard`.
Ingester = Callable[[datetime, datetime], pl.LazyFrame]

# Per-tier work partitions the long_df by `s2_cell.hash() % PIVOT_CHUNKS` so
# each chunk's groupby+pivot transient stays bounded. 16 keeps per-chunk
# data at ~1/16 of total → per-worker peak ~1 GB instead of ~12 GB. Tune
# this if cell count or block size changes materially.
PIVOT_CHUNKS = 16


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

    # Load source ONCE — ingester already returns long form
    # (cell, dt, metric, state, count). Collect eagerly; subsequent
    # per-tier work iterates this DataFrame instead of rescanning the
    # lazy source for each (tier, period).
    import time
    t_ingest = time.time()
    src_lf = ingester(block_from, block_to)
    long_df = src_lf.collect(engine='streaming')
    err(f"  block {_block_id(block_from, block_to)}: "
        f"collected {len(long_df):,} long-form rows in {time.time() - t_ingest:.1f}s")

    # For each derived tier, compute its shards.
    for tier in derived:
        t_tier = time.time()
        tier_finals = tier_partials = tier_empty = tier_bytes = 0
        # Largest rung = old canonical shard; we only materialize that here.
        # Intermediate rungs come from CFW (new data) or P7 backfill (history).
        largest_shard = tier.shards[-1]
        for period in shard_periods_covering(block_from, block_to, largest_shard):
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
                tier_empty += 1
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
            tier_bytes += len(data)

            if not partial:
                key = substitute_key(
                    pyramid.keyTemplate,
                    {'tier': tier.name, 'shard': largest_shard, 'period': period.label},
                )
                pyramid.storage.put(key, data)
                result.finals.append(key)
                tier_finals += 1
            else:
                staging_tmpl = staging_key_template or f"_tmp/{block_id}/{{tier}}/{{period}}.parquet"
                staging_key = substitute_key(
                    staging_tmpl,
                    {'tier': tier.name, 'period': period.label, 'block_id': block_id},
                )
                target_storage = staging_storage or pyramid.storage
                target_storage.put(staging_key, data)
                result.partials.append((tier.name, period.label, staging_key))
                tier_partials += 1
        err(f"    tier {tier.name}: {tier_finals} finals, {tier_partials} partials, "
            f"{tier_empty} empty, {tier_bytes/1024:.0f} KiB, {time.time() - t_tier:.1f}s")

    return result


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

    # Chunk by an s2_cell hash bucket so groupby+pivot run on slices of the
    # block, not the whole thing at once. The unchunked path peaked at
    # ~10–14 GB per worker during the per-tier pivot for tier 2m on a 1d
    # block (× 4 workers = OOM at 55 GB). Each (s2_cell, dt_out) lives in
    # exactly one chunk, so chunked sums equal the unchunked sums.
    bucketed = bucketed.with_columns(
        (pl.col('s2_cell').hash(seed=0) % PIVOT_CHUNKS).alias('_chunk')
    )

    group_cols = dim_names + ['dt_out', 'metric', 'state']
    out_chunks: list[pl.DataFrame] = []
    for chunk in bucketed.partition_by('_chunk', maintain_order=False):
        chunk = chunk.drop('_chunk')
        summed = chunk.group_by(group_cols).agg(pl.col('count').sum())
        per_metric = _build_hist_json(
            summed,
            group_keys=dim_names + ['dt_out', 'metric'],
            state_col='state',
            count_col='count',
        )
        out_chunks.append(per_metric.pivot(
            on='metric',
            index=dim_names + ['dt_out'],
            values='hist_json',
        ))

    # Diagonal concat aligns schemas (chunks may differ on which metric
    # columns survived their pivot if a metric had no rows in that chunk).
    pivoted = pl.concat(out_chunks, how='diagonal_relaxed').rename({'dt_out': bin_col})

    # Ensure every metric column exists (in case it was missing in ALL chunks).
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
