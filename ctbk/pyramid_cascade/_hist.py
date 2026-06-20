"""Shared vectorized histogram-JSON builder.

Reused by:
  - engine._build_tier_shard (per-tier shard assembly)
  - avail_ingester.avail_ingest_1m (base-tier ingest)
  - orchestrator._merge_long (reduce-phase shard merge)

The histogram JSON shape is `{"state":count, ...}` with numerically
sorted state keys (for byte-stable diffs). Built entirely with native
Polars expressions; no `map_elements` (those land you in GIL-bound
per-row Python and tank wall time).
"""
from __future__ import annotations

import polars as pl


def build_hist_json_lazy(
    df,
    *,
    group_keys: list[str],
    state_col: str = 'state',
    count_col: str = 'count',
    out_col: str = 'hist_json',
) -> pl.LazyFrame | pl.DataFrame:
    """Given a frame with `(group_keys..., state, count)` rows, return one
    row per group_keys with a `hist_json` Utf8 column.

    Caller is responsible for upstream filtering / null handling — any
    rows passed in here become part of the histogram.

    Accepts either a `LazyFrame` or `DataFrame`; returns the same kind.
    `state_col` may be any integer dtype (we cast to Utf8 for output).
    """
    return (
        df
        .with_columns(
            pl.concat_str([
                pl.lit('"'),
                pl.col(state_col).cast(pl.Utf8),
                pl.lit('":'),
                pl.col(count_col).cast(pl.Utf8),
            ]).alias('_kv')
        )
        .sort(state_col)
        .group_by(group_keys)
        .agg(pl.col('_kv'))
        .with_columns(
            (pl.lit('{') + pl.col('_kv').list.join(',') + pl.lit('}')).alias(out_col)
        )
        .drop('_kv')
    )
