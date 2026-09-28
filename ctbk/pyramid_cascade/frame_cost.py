"""Frame-cost probes over one pyramid shard's parquet footer
(`specs/timelapse-map.md` §"Frame cost"): which row groups a time bin
touches (RG pruning on `dt` min/max stats), the bytes a reader fetches
for those RGs under a column projection, and whether consecutive bins
land in adjacent byte ranges. Footer-only: nothing here reads data pages.

Byte accounting follows the parquet physical layout — an RG's column
chunks are laid out back to back, so a projection's fetch for one RG is
the union of its chunks' `[offset, offset + compressed)` spans, and a run
of bins is the union of the spans of the RGs they touch.
"""
from __future__ import annotations

from dataclasses import dataclass

import pyarrow.parquet as pq

DT = 'dt'


@dataclass(frozen=True)
class ShardInfo:
    rows: int
    row_groups: int
    footer_bytes: int
    columns: tuple[str, ...]
    sort: str | None
    rg_size: int | None


@dataclass(frozen=True)
class RgSpan:
    """One RG's bytes under a projection: `lo`/`hi` bound the union of the
    projected chunks; `bytes` is their summed compressed size (what a
    per-chunk range reader fetches; `hi - lo` is what a single-range reader
    fetches, equal when the projected columns are contiguous)."""
    rg: int
    rows: int
    dt_min: int
    dt_max: int
    lo: int
    hi: int
    bytes: int


@dataclass(frozen=True)
class BinCost:
    bin: int
    rgs: tuple[int, ...]
    rows: int
    lo: int
    hi: int
    bytes: int
    all_bytes: int


def shard_info(md: pq.FileMetaData) -> ShardInfo:
    kv = {k.decode(): v.decode() for k, v in (md.metadata or {}).items() if not k.startswith(b'ARROW:')}
    rg_size = kv.get('pyrmts.row_group_size')
    return ShardInfo(
        rows=md.num_rows,
        row_groups=md.num_row_groups,
        footer_bytes=md.serialized_size,
        columns=tuple(md.schema.column(i).path for i in range(md.num_columns)),
        sort=kv.get('pyrmts.sort'),
        rg_size=int(rg_size) if rg_size is not None else None,
    )


def rg_spans(md: pq.FileMetaData, columns: list[str] | None = None) -> list[RgSpan]:
    names = [md.schema.column(i).path for i in range(md.num_columns)]
    idxs = [names.index(c) for c in columns] if columns is not None else list(range(len(names)))
    dt_idx = names.index(DT)
    out = []
    for i in range(md.num_row_groups):
        rg = md.row_group(i)
        lo, hi, total = None, None, 0
        for j in idxs:
            cc = rg.column(j)
            offs = [o for o in (cc.dictionary_page_offset, cc.data_page_offset) if o is not None]
            start = min(offs)
            end = start + cc.total_compressed_size
            lo = start if lo is None else min(lo, start)
            hi = end if hi is None else max(hi, end)
            total += cc.total_compressed_size
        st = rg.column(dt_idx).statistics
        out.append(RgSpan(rg=i, rows=rg.num_rows, dt_min=st.min, dt_max=st.max, lo=lo, hi=hi, bytes=total))
    return out


def covering_rgs(spans: list[RgSpan], lo: int, hi: int) -> list[int]:
    """RGs whose `dt` stats intersect the half-open bin `[lo, hi)`."""
    return [s.rg for s in spans if s.dt_min < hi and s.dt_max >= lo]


def _union(spans: list[RgSpan], rgs: list[int]) -> tuple[int, int, int]:
    if not rgs:
        return 0, 0, 0
    sel = [spans[i] for i in rgs]
    return min(s.lo for s in sel), max(s.hi for s in sel), sum(s.bytes for s in sel)


def bin_cost(proj: list[RgSpan], full: list[RgSpan], bin_: int, dur_ms: int) -> BinCost:
    rgs = covering_rgs(proj, bin_, bin_ + dur_ms)
    lo, hi, b = _union(proj, rgs)
    _, _, ab = _union(full, rgs)
    return BinCost(bin=bin_, rgs=tuple(rgs), rows=sum(proj[i].rows for i in rgs), lo=lo, hi=hi, bytes=b, all_bytes=ab)


def run_cost(proj: list[RgSpan], full: list[RgSpan], bin0: int, n: int, dur_ms: int) -> BinCost:
    """Cost of `n` consecutive bins from `bin0` as one read: union of the
    RGs any of them touches."""
    rgs = covering_rgs(proj, bin0, bin0 + n * dur_ms)
    lo, hi, b = _union(proj, rgs)
    _, _, ab = _union(full, rgs)
    return BinCost(bin=bin0, rgs=tuple(rgs), rows=sum(proj[i].rows for i in rgs), lo=lo, hi=hi, bytes=b, all_bytes=ab)


def adjacent(prev: BinCost, cur: BinCost) -> bool:
    """Consecutive bins read adjacent bytes: they share an RG, or the next
    read starts where the previous ended."""
    return bool(set(prev.rgs) & set(cur.rgs)) or prev.hi == cur.lo


def sample_bins(spans: list[RgSpan], dur_ms: int, n: int) -> list[int]:
    """`n` bins spread evenly over the shard's populated `dt` range (first
    and last always included when `n >= 2`)."""
    lo = min(s.dt_min for s in spans)
    hi = max(s.dt_max for s in spans)
    nbins = (hi - lo) // dur_ms + 1
    if n >= nbins:
        return [lo + i * dur_ms for i in range(nbins)]
    if n == 1:
        return [lo]
    return [lo + round(i * (nbins - 1) / (n - 1)) * dur_ms for i in range(n)]
