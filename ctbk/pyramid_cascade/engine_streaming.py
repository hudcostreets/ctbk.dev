"""Streaming-accumulator cascade engine.

Single-pass over source shards in time order. Maintains per-`(tier, period)`
Python dict accumulators of shape `(cell, dt_out, metric) → {state: count}`,
flushes each accumulator to a parquet shard on R2 the moment its output
period rolls over. Memory bounded by *live distinct keys per open period*,
not by source row volume.

Design ported from the prior `ctbk.avail_v3.cascade_from_1m` (which the
perf spec measured at 5–10 min for full rebuild at ~750 MB peak), now
generalized to the pyramid-cascade framework so the same engine drives
any pyramid config.

This engine is single-process by design — a per-shard 14-tier dict-merge
dominates wall, and IPC-pickling those partials to a ProcessPool slows
the total. For coarse parallelism across a long range, split the range
into year-aligned blocks and run independent invocations.

Source contract: an iterator yielding `(shard_start_unix_ms, pa.Table)`
in chronological order. The Table schema must match the pyramid's base
tier — for avail-v3 that's `(s2_cell: Utf8, dt: Int64, <metric>: Utf8)`
where the metric columns hold hist-JSON strings (`{"state":count,...}`).
"""
from __future__ import annotations

import io
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterator

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
from pyrmts import (
    Pyramid,
    parse_duration,
    shard_periods_covering,
    substitute_key,
)
from pyrmts.axis import floor_to_span
from utz import err

from ._hist import build_hist_json_lazy as _build_hist_json
from .config import rg_size_for


# Source iterator contract.
SourceStream = Callable[[datetime, datetime], Iterator[tuple[int, pa.Table]]]


@dataclass
class StreamingRunResult:
    finals: int = 0
    bytes_written: int = 0
    wall_seconds: float = 0.0
    source_shards_read: int = 0
    source_rows_read: int = 0

    def __str__(self) -> str:
        return (
            f"streaming: {self.source_shards_read} source shards, "
            f"{self.source_rows_read:,} source rows → "
            f"{self.finals} finals, {self.bytes_written:,} bytes, "
            f"wall {self.wall_seconds:.1f}s"
        )


def cascade_streaming(
    pyramid: Pyramid,
    range_: tuple[datetime, datetime],
    source_stream: SourceStream,
    *,
    base_tier_name: str | None = None,
    rg_sizes: dict[str, int] | None = None,
) -> StreamingRunResult:
    """Run the streaming-accumulator cascade.

    Reads source shards via `source_stream(range_from, range_to)`,
    iterates them in chronological order, and writes each derived tier's
    output shards to `pyramid.storage` as they complete.

    Returns counts + wall time. Errors propagate (no silent skips).
    """
    t0 = time.time()
    result = StreamingRunResult()
    range_from, range_to = range_

    base = pyramid.tier(base_tier_name) if base_tier_name else pyramid.tiers[0]
    derived = [t for t in pyramid.tiers if t.name != base.name]

    dim_name = pyramid.dims[0].name  # avail: 's2_cell'
    bin_col = pyramid.binCol            # 'dt'
    metric_names = [m.name for m in pyramid.metrics]

    # Pre-compute per-tier bin info (fixed-duration vs calendar).
    tier_info: dict[str, dict] = {}
    for t in derived:
        bin_span = parse_duration(t.bin)
        is_calendar = bin_span.unit in ('mo', 'y')
        if is_calendar:
            tier_info[t.name] = {
                'tier': t,
                'is_calendar': True,
                'bin_span': bin_span,
                'shard': t.shard,
            }
        else:
            unit_ms = {'min': 60_000, 'h': 3_600_000, 'd': 86_400_000}[bin_span.unit]
            tier_info[t.name] = {
                'tier': t,
                'is_calendar': False,
                'bin_ms': bin_span.count * unit_ms,
                'shard': t.shard,
            }

    # accum[(tier_name, period_label)] = {(cell, dt_out_ms, metric): {state: count}}
    accum: dict[tuple[str, str], dict[tuple[str, int, str], dict[str, int]]] = {}
    open_period: dict[str, str] = {}  # tier_name → currently-open period label

    def _flush(tier_name: str, period_label: str) -> None:
        data = accum.pop((tier_name, period_label), None)
        if not data:
            return
        t_flush = time.time()
        table = _accum_to_table(data, dim_name, bin_col, metric_names)
        # Sort cell-first for RG-prune-friendly reads.
        table = table.sort_by([(dim_name, 'ascending'), (bin_col, 'ascending')])
        buf = io.BytesIO()
        pq.write_table(
            table, buf,
            row_group_size=rg_size_for(rg_sizes, tier_name),
            compression='snappy',
        )
        blob = buf.getvalue()
        key = substitute_key(
            pyramid.keyTemplate,
            {'tier': tier_name, 'period': period_label},
        )
        pyramid.storage.put(key, blob)
        result.finals += 1
        result.bytes_written += len(blob)
        err(f"  flush {tier_name:4s} {period_label}: "
            f"{table.num_rows:,} rows, {len(blob)/1024:.0f} KiB, "
            f"{time.time() - t_flush:.1f}s")

    # Stream the source.
    for shard_dt_ms, tab in source_stream(range_from, range_to):
        result.source_shards_read += 1
        result.source_rows_read += tab.num_rows

        # Materialize the source columns once.
        cell_col = tab[dim_name].to_pylist()
        dt_col = tab[bin_col].to_pylist()
        hist_cols_in = {m: tab[m].to_pylist() for m in metric_names}
        n_rows = tab.num_rows

        # Parse each row's hist JSON ONCE per source row; reuse the parsed
        # dict across all derived tiers' updates.
        row_parsed: list[list[tuple[str, dict[str, int]]]] = []
        for i in range(n_rows):
            this_row: list[tuple[str, dict[str, int]]] = []
            for m in metric_names:
                js = hist_cols_in[m][i]
                if js is None:
                    continue
                d = json.loads(js)
                if d:
                    this_row.append((m, d))
            row_parsed.append(this_row)

        # Memoize dt_in → dt_out per (tier, unique_dt_in). Inputs within
        # one source hour share ≤60 unique dts; memoizing here turns
        # ~14_tiers × 60K → ~14_tiers × 60 floor calls per source shard.
        unique_dts = sorted(set(dt_col))
        dt_out_for_tier: dict[str, dict[int, int]] = {}

        shard_dt_obj = datetime.fromtimestamp(shard_dt_ms / 1000, tz=timezone.utc)

        for t in derived:
            info = tier_info[t.name]
            # Output period for this source shard.
            shard_str = info['shard']
            if shard_str == 'all':
                period_label = 'all'
            else:
                periods = list(shard_periods_covering(
                    shard_dt_obj,
                    shard_dt_obj + timedelta(milliseconds=1),
                    shard_str,
                ))
                if not periods:
                    continue
                period_label = periods[0].label

            # Flush on rollover.
            prev = open_period.get(t.name)
            if prev is not None and prev != period_label:
                _flush(t.name, prev)
            open_period[t.name] = period_label

            # dt_in → dt_out lookup table for this tier.
            bin_map = dt_out_for_tier.get(t.name)
            if bin_map is None:
                if info['is_calendar']:
                    bin_span = info['bin_span']
                    bin_map = {}
                    for dt_in in unique_dts:
                        ts = datetime.fromtimestamp(dt_in / 1000, tz=timezone.utc)
                        bin_map[dt_in] = int(floor_to_span(ts, bin_span).timestamp() * 1000)
                else:
                    bin_ms = info['bin_ms']
                    bin_map = {dt_in: (dt_in // bin_ms) * bin_ms for dt_in in unique_dts}
                dt_out_for_tier[t.name] = bin_map

            acc = accum.setdefault((t.name, period_label), {})
            for i in range(n_rows):
                parsed = row_parsed[i]
                if not parsed:
                    continue
                cell = cell_col[i]
                dt_out = bin_map[dt_col[i]]
                for m, d in parsed:
                    key = (cell, dt_out, m)
                    inner = acc.get(key)
                    if inner is None:
                        # Copy — subsequent rows for the same key shouldn't
                        # mutate the source parsed dict (which is reused
                        # across tiers).
                        acc[key] = dict(d)
                    else:
                        for k, v in d.items():
                            inner[k] = inner.get(k, 0) + v

        if result.source_shards_read % 24 == 0:
            err(f"  streamed {result.source_shards_read} source shards, "
                f"{result.source_rows_read:,} rows, "
                f"open_periods={len(accum)}")

    # Final flush — every still-open accumulator.
    for tier_name, period_label in list(open_period.items()):
        _flush(tier_name, period_label)

    result.wall_seconds = time.time() - t0
    return result


def _accum_to_table(
    data: dict[tuple[str, int, str], dict[str, int]],
    dim_name: str,
    bin_col: str,
    metric_names: list[str],
) -> pa.Table:
    """Pivot a `(cell, dt_out, metric) → hist_dict` accumulator into a
    wide pa.Table `(cell, dt_out, *metric_hist_json)`. Histograms are
    sorted by integer state for byte-stable diffs.

    Vectorized via Polars: flatten the dict-of-dicts into 5 parallel
    Python lists (one pass), construct a long-form DataFrame, then use
    `build_hist_json_lazy` (native `concat_str` + `list.join`) and
    `pivot` to assemble the wide output.

    The pure-Python predecessor (json.dumps per (cell, dt_out, metric)
    accumulator entry) cost ~30 µs/entry; on a 11M-entry flush it ran
    ~68 s. The vectorized path moves the heavy work into Polars.
    """
    if not data:
        return _empty_table(dim_name, bin_col, metric_names)

    # Pre-size the flat lists so we avoid reallocating during append.
    n_entries = sum(len(h) for h in data.values())
    cells: list[str] = [''] * n_entries
    dts: list[int] = [0] * n_entries
    metrics: list[str] = [''] * n_entries
    states: list[int] = [0] * n_entries
    counts: list[int] = [0] * n_entries

    i = 0
    for (cell, dt_out, metric), hist in data.items():
        for state, count in hist.items():
            cells[i] = cell
            dts[i] = dt_out
            metrics[i] = metric
            states[i] = int(state)
            counts[i] = count
            i += 1

    long_df = pl.DataFrame({
        dim_name: cells,
        bin_col: dts,
        'metric': metrics,
        'state': states,
        'count': counts,
    })

    per_metric = _build_hist_json(
        long_df,
        group_keys=[dim_name, bin_col, 'metric'],
        state_col='state',
        count_col='count',
    )
    pivoted = per_metric.pivot(
        on='metric',
        index=[dim_name, bin_col],
        values='hist_json',
    )

    # Ensure every metric column exists (Polars pivot drops metrics with
    # zero rows; rare here since every accumulator entry has data, but
    # cheap insurance).
    for m in metric_names:
        if m not in pivoted.columns:
            pivoted = pivoted.with_columns(pl.lit(None, dtype=pl.Utf8).alias(m))

    return pivoted.select([dim_name, bin_col, *metric_names]).to_arrow()


def _empty_table(dim_name: str, bin_col: str, metric_names: list[str]) -> pa.Table:
    arrays = [pa.array([], type=pa.string()), pa.array([], type=pa.int64())]
    names = [dim_name, bin_col]
    for m in metric_names:
        arrays.append(pa.array([], type=pa.string()))
        names.append(m)
    return pa.table(arrays, names=names)
