"""Engine raw-ingest source for rides pyramids (`specs/rides-v5.md`).

One tile per calendar month: `normalized/<YYYYMM>.parquet` (rides that
**end** in the month, on the public S3 `ctbk` bucket — NOT the R2 bucket
the pyramid writes to, hence the injectable `fetch_fn`). Emits long-form
rows for two `sum`-monoid metrics (`count`, `duration`) over dims
`(cell, gender, user_type, bike_type)`, keyed by station identity:
canonical short_name → frozen-vocab chain (coarse cells + `s:<short_name>`),
with a per-ride S2 coordinate fallback (vocab cells excluded) for the
rare unmapped station ids — the same keying rules as `rides_v1.py`'s v3
builder, re-based onto the vocab graph.

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
from typing import Callable, Literal

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

FALLBACK_LEVELS: tuple[int, ...] = (10, 11, 12, 13, 14, 15)

HOUR_MS = 3_600_000


def _month_start(at: datetime) -> datetime:
    return datetime(at.year, at.month, 1, tzinfo=timezone.utc)


def _next_month(at: datetime) -> datetime:
    return datetime(
        at.year + (at.month == 12), at.month % 12 + 1, 1, tzinfo=timezone.utc,
    )


class MonthlyRidesSource(TiledSource):
    """`chains` maps canonical short_name → key rows (vocab coarse cells
    + `s:<short_name>`); `canonical` maps raw ride station ids to those
    short_names; `geo` fills null coordinates for the fallback path;
    `vocab_cells` is the fallback-exclusion set; `available_months` (a
    set of 'YYYYMM' strings) gates the start-anchor spillback tile;
    `fetch_fn` reads a tile key → bytes (S3, not the pyramid's R2)."""

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
    ) -> None:
        super().__init__(pyramid)
        self.anchor: Anchor = anchor
        # v3 canonicalization semantics (`canon.get(sid, sid)`): the
        # id-map wins, else the sid ITSELF is the candidate short_name —
        # modern rides carry short_names ('JC149') directly as station
        # ids, absent from the legacy id-map.
        self._canonical = {sn: sn for sn in chains} | canonical
        self._geo = geo
        self._vocab_cells = vocab_cells
        self._available = available_months
        self._fetch_fn = fetch_fn
        self._chains = pl.DataFrame(
            {'short_name': list(chains), 'cell': list(chains.values())},
            schema={'short_name': pl.Utf8, 'cell': pl.List(pl.Utf8)},
        )

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

    def fetch(self, key: str) -> bytes | None:
        return self._fetch_fn(key)

    def parse(self, blob: bytes, tile: Tile) -> pl.DataFrame:
        cols = ANCHOR_COLS[self.anchor]
        df = pl.read_parquet(
            BytesIO(blob),
            columns=[
                'Start Time', 'Stop Time', cols['sid'], cols['lat'], cols['lng'],
                'Gender', 'User Type', 'Rideable Type',
            ],
        )
        # Dim dtypes vary by era (early months dictionary-encode
        # `User Type`/`Rideable Type`/even `Gender` as Categorical;
        # later ones use Int8/Utf8): route everything through Utf8
        # before typing. Gender's Utf8→Float64→Int64 chain absorbs both
        # '1' and '1.0' renderings.
        df = df.with_columns(
            pl.col(cols['time']).dt.truncate('1h').dt.epoch('ms').alias('dt'),
            (pl.col('Stop Time') - pl.col('Start Time'))
                .dt.total_seconds().cast(pl.Int64).alias('dur_s'),
            pl.col('Gender').cast(pl.Utf8).cast(pl.Float64, strict=False)
                .fill_null(0).cast(pl.Int64)
                .replace_strict(GENDER_MAP, default='unknown').alias('gender'),
            pl.col('User Type').cast(pl.Utf8).fill_null('unknown').alias('user_type'),
            pl.col('Rideable Type').cast(pl.Utf8).fill_null('unknown').alias('bike_type'),
            pl.col(cols['sid']).cast(pl.Utf8).alias('sid'),
        )
        df = df.with_columns(
            pl.col('sid').replace_strict(self._canonical, default=None).alias('short_name'),
        )
        # Mapped = canonicalized to a short_name that HAS a chain; a
        # canonical name absent from the chains (registry drift) falls
        # back to coordinates, exactly like an unmapped sid (v3 rule).
        has_chain = pl.col('short_name').is_in(self._chains['short_name'])
        mapped = df.filter(pl.col('short_name').is_not_null() & has_chain)
        unmapped = df.filter(pl.col('short_name').is_null() | ~has_chain)

        long = (
            mapped
            .join(self._chains, on='short_name', how='inner')
            .select('cell', 'dt', 'gender', 'user_type', 'bike_type', 'dur_s')
            .explode('cell')
        )
        frames = [long]
        if unmapped.height:
            fb = self._fallback_frame(unmapped)
            if fb is not None:
                frames.append(fb)

        grouped = (
            pl.concat(frames)
            .group_by(['cell', 'dt', 'gender', 'user_type', 'bike_type'])
            .agg(
                pl.len().alias('n'),
                pl.col('dur_s').sum().alias('dsum'),
                (pl.col('dur_s') * pl.col('dur_s')).sum().alias('dsumsq'),
            )
        )
        # Native sum-monoid long form: `metric` holds the state-column
        # name, `state` is null, `count` the value. `count`'s n/sum/sumsq
        # are all the ride count (value = 1), kept for v3 schema symmetry.
        return (
            grouped
            .unpivot(
                index=['cell', 'dt', 'gender', 'user_type', 'bike_type'],
                on=['n', 'dsum', 'dsumsq'],
                variable_name='metric',
                value_name='count',
            )
            .with_columns(
                pl.col('metric').replace_strict({
                    'n': 'duration_n', 'dsum': 'duration_sum', 'dsumsq': 'duration_sumsq',
                }),
                pl.lit(None, dtype=pl.Int32).alias('state'),
                pl.col('count').cast(pl.Float64),
            )
            # long_schema column order: dims, binCol, metric, state, count
            # (concat with `empty_long` frames is order-sensitive).
            .select('cell', 'gender', 'user_type', 'bike_type', 'dt', 'metric', 'state', 'count')
            # count metric: n == sum == sumsq == ride count (value ≡ 1).
            .pipe(self._with_count_metric)
            # Match `empty_long`'s dtypes (metric Enum): a window mixing a
            # parsed spillback tile with a missing tile's empty frame
            # vstacks them before `read_window`'s final cast.
            .cast(long_schema(self.pyramid))
        )

    def _with_count_metric(self, dur_long: pl.DataFrame) -> pl.DataFrame:
        n_rows = dur_long.filter(pl.col('metric') == 'duration_n')
        frames = [dur_long] + [
            n_rows.with_columns(pl.lit(m).alias('metric'))
            for m in ('count_n', 'count_sum', 'count_sumsq')
        ]
        return pl.concat(frames)

    def _fallback_frame(self, unmapped: pl.DataFrame) -> pl.DataFrame | None:
        """Coordinate-fallback rows for rides whose station id has no
        canonical mapping: S2 tokens at `FALLBACK_LEVELS` from the ride's
        coordinates (geo-lookup fill for null coords), vocab cells
        excluded so fallback mass never lands in a station's bucket.
        Rides with neither mapping nor usable coordinates are dropped."""
        import s2cell

        cols = ANCHOR_COLS[self.anchor]
        rows = unmapped.select(
            'sid', cols['lat'], cols['lng'], 'dt', 'gender', 'user_type', 'bike_type', 'dur_s',
        ).rows()
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
                chain_cache[key] = chain
            for t in chain:
                cells.append(t)
                idx.append(i)
        if not cells:
            return None
        base = unmapped.select('dt', 'gender', 'user_type', 'bike_type', 'dur_s')[idx]
        return base.with_columns(pl.Series('cell', cells, dtype=pl.Utf8)).select(
            'cell', 'dt', 'gender', 'user_type', 'bike_type', 'dur_s',
        )
