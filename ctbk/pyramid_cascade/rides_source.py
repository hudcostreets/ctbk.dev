"""Engine raw-ingest source for rides pyramids (`specs/rides-v5.md`).

One tile per calendar month: `normalized/<YYYYMM>.parquet` (rides that
**end** in the month, on the public S3 `ctbk` bucket — NOT the R2 bucket
the pyramid writes to, hence the injectable `fetch_fn`). Emits long-form
rows for the pyramid's `sum`-monoid metrics (`count`, and `duration` when
declared) over the pyramid's dims (`cell` + any of `gender`, `user_type`,
`bike_type`; undeclared rider dims are summed away at ingest), keyed by
station identity: canonical short_name → frozen-vocab chain (coarse cells
+ `s:<short_name>`), with a per-ride S2 coordinate fallback (vocab cells
excluded) for the rare unmapped station ids — station-identity keying
re-based onto the vocab graph.

Identity-only mode (`identity_only=True`; `specs/timelapse-map.md`, set
by the `rides-tl-*` factories — those configs declare no `geo` block):
each mapped ride keys ONLY its raw `s:<sid>` leaf, no vocab-chain rows,
and an unmapped ride keys only its coarsest non-vocab fallback cell, so a
bin's non-`s:` rows sum to exactly its unmapped rides.

Anchor semantics: `end` tiles align exactly with tile months. `start`
windows additionally need the NEXT month's tile (a ride starting 23:50 on
the month's last day ends — and is therefore stored — in the next month's
parquet). `tiles_for` appends that spillback tile only when it exists in
`available_months`: mid-history absence stays a strict coverage miss via
the normal path, while the tip's not-yet-published next month reads as
empty — its boundary rides arrive with the next monthly ingest, which
invalidates the affected shards (shard-invalidation journal) rather than
blocking the newest month's build.

Deliberately ctbk-package-independent (pyrmts + polars + s2cell +
stdlib) so it flat-copies into the Batch engine image.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from typing import Callable, Literal, Sequence

import polars as pl

from pyrmts import Pyramid, ShardPeriod
from pyrmts_engine.longform import long_schema
from pyrmts_engine.source import Tile, TiledSource

NORMALIZED_PREFIX = 'normalized'

Anchor = Literal['start', 'end']

GENDER_MAP = {0: 'unknown', 1: 'male', 2: 'female'}

ANCHOR_COLS: dict[Anchor, dict[str, str]] = {
    'start': {
        'time': 'Start Time',
        'sid': 'Start Station ID',
        'lat': 'Start Station Latitude',
        'lng': 'Start Station Longitude',
    },
    'end': {
        'time': 'Stop Time',
        'sid': 'End Station ID',
        'lat': 'End Station Latitude',
        'lng': 'End Station Longitude',
    },
}

CELL_DIM = 'cell'
IDENTITY_PREFIX = 's:'

# Rider dims → the normalized-parquet column each is typed from. Dim
# dtypes vary by era (early months dictionary-encode `User Type`/
# `Rideable Type`/even `Gender` as Categorical; later ones use
# Int8/Utf8): route everything through Utf8 before typing. Gender's
# Utf8→Float64→Int64 chain absorbs both '1' and '1.0' renderings.
RIDER_DIM_COLS: dict[str, str] = {
    'gender': 'Gender',
    'user_type': 'User Type',
    'bike_type': 'Rideable Type',
}
RIDER_DIM_EXPRS: dict[str, pl.Expr] = {
    'gender': pl.col('Gender').cast(pl.Utf8).cast(pl.Float64, strict=False)
        .fill_null(0).cast(pl.Int64)
        .replace_strict(GENDER_MAP, default='unknown').alias('gender'),
    'user_type': pl.col('User Type').cast(pl.Utf8).fill_null('unknown').alias('user_type'),
    'bike_type': pl.col('Rideable Type').cast(pl.Utf8).fill_null('unknown').alias('bike_type'),
}

METRICS = ('count', 'duration')

FALLBACK_LEVELS: tuple[int, ...] = (10, 11, 12, 13, 14, 15)

HOUR_MS = 3_600_000


def _month_start(at: datetime) -> datetime:
    return datetime(at.year, at.month, 1, tzinfo=timezone.utc)


def _next_month(at: datetime) -> datetime:
    return datetime(
        at.year + (at.month == 12), at.month % 12 + 1, 1, tzinfo=timezone.utc,
    )


def station_positions(
    registry: dict[str, tuple[float, float]],
    canonical: dict[str, str],
    geo: dict[str, tuple[float, float]],
) -> dict[str, tuple[float, float]]:
    """Positions to build station chains from: the registry
    (`station-luc.json` `by_short_name`) plus every effective canonical it
    lacks, placed at the canonical's own last observed coordinates (`geo`),
    else its first member's (sorted) that has some. The registry is
    GBFS-active ∪ harmonize-history canonicals as of its last build, so a
    later id-map change (e.g. splitting a false merge) can leave a
    canonical unregistered; without this its rides would drop to the
    coordinate fallback — no vocab cells, invisible to region covers and
    system totals. Canonicals with no coordinates anywhere stay absent."""
    members: dict[str, list[str]] = {}
    for sid, canon in canonical.items():
        if canon not in registry:
            members.setdefault(canon, []).append(sid)
    out = dict(registry)
    for canon, sids in sorted(members.items()):
        pos = geo.get(canon) or next(
            (geo[s] for s in sorted(sids) if s in geo), None,
        )
        if pos is not None:
            out[canon] = pos
    return out


class MonthlyRidesSource(TiledSource):
    """`chains` maps a station short_name → its vocab chain (coarse cells
    + `s:<short_name>`); only the **cells** are used — the identity leaf
    emitted is the raw reported id `s:<sid>`, so canonicalization stays a
    separate id-map-keyed `c:` rollup. `canonical` maps raw ride station ids
    to short_names (to resolve which station's cells a raw id sits under);
    `geo` fills null coordinates for the fallback path; `vocab_cells` is the
    fallback-exclusion set; `available_months` (a set of 'YYYYMM' strings)
    gates the start-anchor spillback tile; `fetch_fn` reads a tile key →
    bytes (S3, not the pyramid's R2).

    `dims` (default: the pyramid's declared dims) is `cell` followed by
    any of the rider dims; the group-by is `[*dims, 'dt']`, so rider dims
    left undeclared are summed away. Metrics likewise follow the pyramid
    (`count` always; `duration` only when declared). `identity_only`
    keys mapped rides by their `s:<sid>` leaf alone (no chain cells) — see
    the module docstring."""

    def __init__(
        self,
        pyramid: Pyramid,
        anchor: Anchor,
        chains: dict[str, list[str]],
        canonical: dict[str, str],
        geo: dict[str, tuple[float, float]],
        vocab_cells: frozenset[str],
        available_months: set[str],
        fetch_fn: Callable[[str], bytes | None],
        dims: Sequence[str] | None = None,
        identity_only: bool = False,
    ) -> None:
        super().__init__(pyramid)
        self.anchor: Anchor = anchor
        self._dims = [d.name for d in pyramid.dims] if dims is None else list(dims)
        if not self._dims or self._dims[0] != CELL_DIM:
            raise ValueError(f'dims must start with {CELL_DIM!r}, got {self._dims!r}')
        self._rider_dims = self._dims[1:]
        if unknown := set(self._rider_dims) - set(RIDER_DIM_COLS):
            raise ValueError(f'unknown rider dims {sorted(unknown)!r} (want ⊆ {sorted(RIDER_DIM_COLS)!r})')
        self._metrics = [m.name for m in pyramid.metrics]
        if unknown := set(self._metrics) - set(METRICS):
            raise ValueError(f'unknown metrics {sorted(unknown)!r} (want ⊆ {list(METRICS)!r})')
        self.identity_only = identity_only
        # v3 canonicalization semantics (`canon.get(sid, sid)`): the
        # id-map wins, else the sid ITSELF is the candidate short_name —
        # modern rides carry short_names ('JC149') directly as station
        # ids, absent from the legacy id-map.
        self._canonical = {sn: sn for sn in chains} | canonical
        self._geo = geo
        self._vocab_cells = vocab_cells
        self._available = available_months
        self._fetch_fn = fetch_fn
        # Cells only (drop each chain's own `s:<short_name>` leaf): the
        # write path emits the coarse S2-cell ancestors from the station's
        # registered chain, but the identity leaf is the **raw reported id**
        # (`s:<sid>`), not the canonical short_name — canonicalization is a
        # separate, id-map-keyed `c:` rollup materialized by pyrmts's
        # `identityRollup` pass (`specs/materialized-canonicalization.md`), so
        # an id-map fix never touches these raw leaves. `_canonical` is still
        # used to resolve which station's cells a raw id sits under.
        # Identity-only mode keeps the frame (membership = "registered
        # station") but emits none of the cells.
        cells_only = {
            sn: [] if identity_only else [c for c in chain if not c.startswith(IDENTITY_PREFIX)]
            for sn, chain in chains.items()
        }
        self._cells = pl.DataFrame(
            {'short_name': list(cells_only), 'cells': list(cells_only.values())},
            schema={'short_name': pl.Utf8, 'cells': pl.List(pl.Utf8)},
        )

    @property
    def _has_duration(self) -> bool:
        return 'duration' in self._metrics

    @property
    def _value_cols(self) -> list[str]:
        """Per-ride columns carried from parse to the group-by: the rider
        dims, plus `dur_s` when the pyramid declares `duration`."""
        return [*self._rider_dims] + (['dur_s'] if self._has_duration else [])

    def tile_at(self, at: datetime) -> Tile:
        start = _month_start(at)
        end = _next_month(start)
        return Tile(
            key=f'{NORMALIZED_PREFIX}/{start:%Y%m}.parquet',
            period=ShardPeriod(start=start, end=end, label=f'{start:%Y%m}'),
        )

    def tiles_for(self, start: datetime, end: datetime) -> list[Tile]:
        tiles = super().tiles_for(start, end)
        if self.anchor == 'start':
            spill = self.tile_at(tiles[-1].period.end)
            if f'{spill.period.start:%Y%m}' in self._available:
                tiles.append(spill)
        return tiles

    def present_keys(self, tiles: list[Tile]) -> set[str]:
        """Tiles live on S3, not the pyramid's R2 storage (the chassis
        default would LIST R2 and find none of them); `available_months`
        already IS the S3 listing. The engine's fill mode consults this
        before the walk: an absent OPEN month (the one in progress) defers
        its shards; an absent CLOSED month — published mid-following-month,
        so the whole gap between month-end and publication — holds them
        and fails fast, instead of writing 0-row shards and then tripping
        the coverage guard (2026-09-07: 12 relics per anchor)."""
        return {t.key for t in tiles if f'{t.period.start:%Y%m}' in self._available}

    def fetch(self, key: str) -> bytes | None:
        return self._fetch_fn(key)

    def parse(self, blob: bytes, tile: Tile) -> pl.DataFrame:
        cols = ANCHOR_COLS[self.anchor]
        has_dur = self._has_duration
        time_cols = ['Start Time', 'Stop Time'] if has_dur else [cols['time']]
        df = pl.read_parquet(
            BytesIO(blob),
            columns=[
                *time_cols, cols['sid'], cols['lat'], cols['lng'],
                *(RIDER_DIM_COLS[d] for d in self._rider_dims),
            ],
        )
        exprs = [
            pl.col(cols['time']).dt.truncate('1h').dt.epoch('ms').alias('dt'),
            pl.col(cols['sid']).cast(pl.Utf8).alias('sid'),
            *(RIDER_DIM_EXPRS[d] for d in self._rider_dims),
        ]
        if has_dur:
            exprs.append(
                (pl.col('Stop Time') - pl.col('Start Time'))
                    .dt.total_seconds().cast(pl.Int64).alias('dur_s'),
            )
        df = df.with_columns(*exprs)
        df = df.with_columns(
            pl.col('sid').replace_strict(self._canonical, default=None).alias('short_name'),
        )
        # Mapped = resolves to a short_name whose station HAS registered
        # cells; a name absent from the registry (drift) falls back to
        # coordinates, exactly like an unmapped sid. The identity leaf is the
        # raw `sid` (not the canonical short_name) — appended to the station's
        # coarse cells (none in identity-only mode) before exploding.
        has_cells = pl.col('short_name').is_in(self._cells['short_name'])
        mapped = df.filter(pl.col('short_name').is_not_null() & has_cells)
        unmapped = df.filter(pl.col('short_name').is_null() | ~has_cells)

        value_cols = self._value_cols
        long = (
            mapped
            .join(self._cells, on='short_name', how='inner')
            .with_columns(
                pl.concat_list(pl.col('cells'), (pl.lit(IDENTITY_PREFIX) + pl.col('sid'))).alias(CELL_DIM)
            )
            .select(CELL_DIM, 'dt', *value_cols)
            .explode(CELL_DIM)
        )
        frames = [long]
        if unmapped.height:
            fb = self._fallback_frame(unmapped)
            if fb is not None:
                frames.append(fb)

        aggs = [pl.len().alias('n')]
        if has_dur:
            aggs += [
                pl.col('dur_s').sum().alias('dsum'),
                (pl.col('dur_s') * pl.col('dur_s')).sum().alias('dsumsq'),
            ]
        grouped = pl.concat(frames).group_by([*self._dims, 'dt']).agg(*aggs)
        # Native sum-monoid long form: `metric` holds the state-column
        # name, `state` is null, `count` the value. `count`'s n/sum/sumsq
        # are all the ride count (value ≡ 1), kept for v3 schema symmetry.
        # long_schema column order: dims, binCol, metric, state, count
        # (concat with `empty_long` frames is order-sensitive).
        # Cast to match `empty_long`'s dtypes (metric Enum): a window
        # mixing a parsed spillback tile with a missing tile's empty frame
        # vstacks them before `read_window`'s final cast.
        keys = grouped.select(*self._dims, 'dt')
        state = pl.lit(None, dtype=pl.Int32).alias('state')
        return pl.concat([
            keys.with_columns(
                pl.lit(metric).alias('metric'),
                state,
                grouped[col].cast(pl.Float64).alias('count'),
            )
            for metric, col in self._metric_cols()
        ]).cast(long_schema(self.pyramid))

    def _metric_cols(self) -> list[tuple[str, str]]:
        """(long-form metric name, grouped column) pairs, in emission
        order: `duration_{n,sum,sumsq}` (when declared), then
        `count_{n,sum,sumsq}` — all three of the latter are the ride
        count."""
        out: list[tuple[str, str]] = []
        if self._has_duration:
            out += [('duration_n', 'n'), ('duration_sum', 'dsum'), ('duration_sumsq', 'dsumsq')]
        if 'count' in self._metrics:
            out += [('count_n', 'n'), ('count_sum', 'n'), ('count_sumsq', 'n')]
        return out

    def _fallback_frame(self, unmapped: pl.DataFrame) -> pl.DataFrame | None:
        """Coordinate-fallback rows for rides whose station id has no
        canonical mapping: S2 tokens at `FALLBACK_LEVELS` from the ride's
        coordinates (geo-lookup fill for null coords), vocab cells
        excluded so fallback mass never lands in a station's bucket —
        only the coarsest such token in identity-only mode (one row per
        unmapped ride). Rides with neither mapping nor usable coordinates
        are dropped."""
        import s2cell

        cols = ANCHOR_COLS[self.anchor]
        value_cols = self._value_cols
        rows = unmapped.select('sid', cols['lat'], cols['lng'], 'dt', *value_cols).rows()
        cells: list[str] = []
        idx: list[int] = []
        chain_cache: dict[tuple[float, float], list[str]] = {}
        for i, (sid, lat, lng, *_rest) in enumerate(rows):
            if lat is None or lng is None:
                g = self._geo.get(sid)
                if g is None:
                    continue
                lat, lng = g
            key = (round(lat, 6), round(lng, 6))
            chain = chain_cache.get(key)
            if chain is None:
                chain = [
                    t for lvl in FALLBACK_LEVELS
                    if (t := s2cell.lat_lon_to_token(lat, lng, lvl)) not in self._vocab_cells
                ]
                if self.identity_only:
                    chain = chain[:1]
                chain_cache[key] = chain
            for t in chain:
                cells.append(t)
                idx.append(i)
        if not cells:
            return None
        base = unmapped.select('dt', *value_cols)[idx]
        return base.with_columns(pl.Series(CELL_DIM, cells, dtype=pl.Utf8)).select(
            CELL_DIM, 'dt', *value_cols,
        )
