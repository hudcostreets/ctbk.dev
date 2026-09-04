"""Empty/full station bitmaps: dense `(minute × station)` bit planes on R2, as sharded Zarr v3 arrays.

See `specs/avail-empty-bitmaps.md`. Four planes, one bit per `(minute, station)`:

    observed   an observation exists, station is installed + renting, and not `0 bikes & 0 docks`
    no_bikes   observed && num_bikes_available == 0   (GBFS total: classic + e-bike)
    no_ebikes  observed && num_ebikes_available == 0
    full       observed && num_docks_available == 0

Bits are packed along the station axis (`np.packbits`, big-endian bit order: station `j` →
byte `j // 8`, bit `7 - j % 8`). Layout `empty-v1p/planes`: one uint8 array of shape
`(4, T_MAX, S_MAX/8)`; shard `(4, 1440, 64)` = all planes × one UTC day × 512 stations = one R2
object; inner chunk `(4, 60, 64)` = one hour, gzip'd independently, plane-major inside (each
plane a contiguous 3,840 B block), addressable via the shard's trailing index. All four planes
ride in one read: they're correlated, so packing compresses *better* than separate planes
(0.93×) and the FE can switch condition / recompute k-of-K without another fetch. Absent shard
≡ all-zero ≡ unobserved. (A separate-plane layout was built alongside for the bake-off in §9
of the spec and lost on every axis: 4× the RPCs, ~4× the latency; it has been deleted.)

Time axis: minutes since `EPOCH`; day index = days since `EPOCH`. Station axis: the shared,
append-only vocab `empty-v1/stations.json` (initial order: s2 cell id of each station's
lat/lng, so nearby stations share a shard; unknown stations append at the end).

Increment 1 of the spec: `d1` rung only (complete days, from the daily status parquets).
`query` is the reference implementation of the worker's `/api/empty`.
"""
from __future__ import annotations

import gzip
import json
import struct
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from click import Choice, argument, option
from utz import err

from ctbk.gbfs_cli import gbfs
from ctbk.rides_v1 import r2_client, r2_endpoint

BUCKET = 'ctbk'
VOCAB_KEY = 'empty-v1/stations.json'
STATUS_PREFIX = 'gbfs/status'
EPOCH = datetime(2026, 4, 1, tzinfo=timezone.utc)
MINUTES_PER_DAY = 1440
T_MAX_DAYS = 1827  # EPOCH → 2031-04-01
S_MAX = 4096
SHARD_STATIONS = 512
CHUNK_MINUTES = 60
S_BYTES = S_MAX // 8
SHARD_BYTES = SHARD_STATIONS // 8
N_SHARDS = S_MAX // SHARD_STATIONS
CHUNKS_PER_SHARD = MINUTES_PER_DAY // CHUNK_MINUTES
INDEX_LEN = CHUNKS_PER_SHARD * 16 + 4  # (offset, nbytes) uint64 LE per chunk + crc32c
PLANES = ('observed', 'no_bikes', 'no_ebikes', 'full')
N_PLANES = len(PLANES)
STATUS_COLS = [
    'station_id', 'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
    'is_installed', 'is_renting', 'ts',
]
DEFAULT_CACHE = Path('tmp/status')
ISO_DAY = '%Y-%m-%d'


def day_idx(d: date) -> int:
    return (d - EPOCH.date()).days


def day_of_idx(i: int) -> date:
    return EPOCH.date() + timedelta(days=i)


# ─── Vocab ────────────────────────────────────────────────────────────────

@dataclass
class Vocab:
    stations: list[str]
    index: dict[str, int] = field(init=False)

    def __post_init__(self):
        self.index = {s: i for i, s in enumerate(self.stations)}

    def extend(self, new: Iterable[str]) -> list[str]:
        added = sorted(s for s in set(new) if s not in self.index)
        for s in added:
            self.index[s] = len(self.stations)
            self.stations.append(s)
        if len(self.stations) > S_MAX:
            raise RuntimeError(f"vocab has {len(self.stations)} stations > S_MAX={S_MAX}")
        return added

    @property
    def n_shards(self) -> int:
        return -(-len(self.stations) // SHARD_STATIONS)

    def to_json(self) -> dict:
        return {
            'version': 1,
            'epoch': EPOCH.isoformat(),
            'order': 's2 cell id (level 30) of station lat/lng from station-luc.json; later stations appended by id',
            'stations': self.stations,
        }


def init_vocab(cli) -> Vocab:
    """Initial station order: by s2 cell id of lat/lng, from `station-luc.json`."""
    import s2cell
    luc = json.loads(cli.get_object(Bucket=BUCKET, Key='station-luc.json')['Body'].read())
    by_short = luc['by_short_name']
    rows = []
    for uuid, short in luc['by_uuid'].items():
        e = by_short.get(short)
        if not e or 'lat' not in e:
            continue
        rows.append((s2cell.lat_lon_to_cell_id(e['lat'], e['lng'], 30), uuid))
    rows.sort()
    return Vocab([uuid for _, uuid in rows])


def load_vocab(cli) -> Vocab | None:
    try:
        obj = cli.get_object(Bucket=BUCKET, Key=VOCAB_KEY)
    except cli.exceptions.NoSuchKey:
        return None
    return Vocab(json.loads(obj['Body'].read())['stations'])


def save_vocab(cli, vocab: Vocab) -> None:
    cli.put_object(
        Bucket=BUCKET, Key=VOCAB_KEY,
        Body=json.dumps(vocab.to_json(), indent=None).encode(),
        ContentType='application/json',
    )


# ─── Daily status parquet → planes ────────────────────────────────────────

def status_key(d: date) -> str:
    return f'{STATUS_PREFIX}/{d.strftime(ISO_DAY)}.parquet'


def load_status_day(cli, d: date, cache: Path | None) -> pd.DataFrame:
    import pyarrow.parquet as pq
    path = (cache / f'{d.strftime(ISO_DAY)}.parquet') if cache else None
    if path is None or not path.exists():
        body = cli.get_object(Bucket=BUCKET, Key=status_key(d))['Body'].read()
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        else:
            import io
            return pq.read_table(io.BytesIO(body), columns=STATUS_COLS).to_pandas()
    return pq.read_table(path, columns=STATUS_COLS).to_pandas()


@dataclass
class DayPlanes:
    day: date
    planes: dict[str, np.ndarray]  # each (1440, S_MAX) bool; condition planes forward-filled (see `ffill_planes`)
    n_rows: int
    n_spill: int
    added: list[str]

    def strict(self, plane: str) -> np.ndarray:
        """The condition as actually reported: filled bits masked by `observed`."""
        return self.planes[plane] & self.planes['observed']

    @property
    def carry(self) -> np.ndarray:
        """`(3, S_MAX)` bool: the filled state at the last minute of the day — the seed for the next day."""
        return np.stack([self.planes[p][-1] for p in PLANES[1:]])

    def packed(self, plane: str) -> np.ndarray:
        return np.packbits(self.planes[plane], axis=1)  # (1440, S_BYTES) uint8

    def stacked(self) -> np.ndarray:
        """`(4, 1440, S_BYTES)` uint8, planes in `PLANES` order."""
        return np.stack([self.packed(p) for p in PLANES])

    def hour(self, hour: int, shard: int) -> np.ndarray:
        """`(4, 60, 512)` bool: the reference reader's unit."""
        t0, t1 = hour * CHUNK_MINUTES, (hour + 1) * CHUNK_MINUTES
        return np.stack([self.planes[p][t0:t1, shard * SHARD_STATIONS:(shard + 1) * SHARD_STATIONS] for p in PLANES])


def ffill_planes(planes: dict[str, np.ndarray], seed: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Forward-fill the condition planes over unobserved minutes, uncapped within the day: minute
    `t` takes the condition at the station's last observed minute ≤ t, or `seed` (`(3, S)` bool,
    the previous day's carry) before its first observation. `observed` is left raw, so the stored
    planes are lossless: strict = filled & observed, and any fill horizon N is recoverable from
    the lengths of the unobserved runs. (An un-ticked feed means "unchanged", not "unknown".)"""
    obs = planes['observed']
    T, S = obs.shape
    last = np.maximum.accumulate(np.where(obs, np.arange(T)[:, None], -1), axis=0)  # (T, S) last observed minute ≤ t
    take = np.clip(last, 0, None)
    out = {'observed': obs}
    for i, p in enumerate(PLANES[1:]):
        c = planes[p]
        filled = np.take_along_axis(c, take, axis=0)
        if seed is not None:
            filled = np.where(last >= 0, filled, seed[i][None, :])
        else:
            filled = np.where(last >= 0, filled, False)
        out[p] = filled
    return out


def build_planes(df: pd.DataFrame, d: date, vocab: Vocab, seed: np.ndarray | None = None) -> DayPlanes:
    """Pivot a day's status rows into the four bit planes (condition planes forward-filled, seeded
    from the previous day's carry). Extends `vocab` in place with any station ids it hasn't seen
    (appended in sorted order)."""
    day_start_min = int(datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc).timestamp() // 60)
    minute = (df['ts'] // 60).to_numpy()
    tidx = minute - day_start_min
    in_day = (tidx >= 0) & (tidx < MINUTES_PER_DAY)
    n_spill = int((~in_day).sum())
    df = df[in_day].assign(_t=tidx[in_day])
    df = df.sort_values(['station_id', '_t', 'ts'], kind='mergesort').drop_duplicates(['station_id', '_t'], keep='last')
    added = vocab.extend(df['station_id'].unique())
    sidx = df['station_id'].map(vocab.index).to_numpy()
    t = df['_t'].to_numpy()
    bikes = df['num_bikes_available'].to_numpy()
    ebikes = df['num_ebikes_available'].to_numpy()
    docks = df['num_docks_available'].to_numpy()
    observed = (
        (df['is_installed'].to_numpy() == 1)
        & (df['is_renting'].to_numpy() == 1)
        & ~((bikes == 0) & (docks == 0))
    )
    conds = {
        'observed': observed,
        'no_bikes': observed & (bikes == 0),
        'no_ebikes': observed & (ebikes == 0),
        'full': observed & (docks == 0),
    }
    planes = {}
    for k, m in conds.items():
        a = np.zeros((MINUTES_PER_DAY, S_MAX), dtype=bool)
        a[t[m], sidx[m]] = True
        planes[k] = a
    return DayPlanes(day=d, planes=ffill_planes(planes, seed), n_rows=len(df), n_spill=n_spill, added=added)


# ─── Shard byte access + the reference range-reader (what the worker will do) ──

class Fetch:
    """Counts RPCs and bytes across a query (the worker's budget)."""
    def __init__(self):
        self.rpcs = 0
        self.nbytes = 0

    def add(self, n: int):
        self.rpcs += 1
        self.nbytes += n


class R2Shard:
    """Byte-range access to one shard object on R2."""
    def __init__(self, cli, key: str, fetch: Fetch | None = None):
        self.cli, self.key, self.fetch = cli, key, fetch or Fetch()

    def tail(self, n: int) -> bytes | None:
        try:
            b = self.cli.get_object(Bucket=BUCKET, Key=self.key, Range=f'bytes=-{n}')['Body'].read()
        except self.cli.exceptions.NoSuchKey:
            self.fetch.add(0)
            return None
        self.fetch.add(len(b))
        return b

    def range(self, off: int, n: int) -> bytes:
        b = self.cli.get_object(Bucket=BUCKET, Key=self.key, Range=f'bytes={off}-{off + n - 1}')['Body'].read()
        self.fetch.add(len(b))
        return b

    def whole(self) -> bytes | None:
        try:
            b = self.cli.get_object(Bucket=BUCKET, Key=self.key)['Body'].read()
        except self.cli.exceptions.NoSuchKey:
            self.fetch.add(0)
            return None
        self.fetch.add(len(b))
        return b


class LocalShard:
    """Same interface over a shard file in a `LocalStore` (tests)."""
    def __init__(self, path: Path):
        self.path = path

    def tail(self, n: int) -> bytes | None:
        if not self.path.exists():
            return None
        with open(self.path, 'rb') as f:
            f.seek(-n, 2)
            return f.read(n)

    def range(self, off: int, n: int) -> bytes:
        with open(self.path, 'rb') as f:
            f.seek(off)
            return f.read(n)

    def whole(self) -> bytes | None:
        return self.path.read_bytes() if self.path.exists() else None


class BytesShard:
    """The interface over an already-fetched whole shard (strategy `whole`)."""
    def __init__(self, data: bytes):
        self.data = data

    def tail(self, n: int) -> bytes | None:
        return self.data[-n:]

    def range(self, off: int, n: int) -> bytes:
        return self.data[off:off + n]


def hour_chunk_bytes(shard, hour: int) -> bytes | None:
    """One hour's inner chunk, decompressed, from a shard: fetch the trailing index
    (`CHUNKS_PER_SHARD` × (offset, nbytes) uint64 LE, then crc32c), range-read the chunk,
    gunzip. None if the shard is absent (all-unobserved) or the chunk is empty."""
    idx = shard.tail(INDEX_LEN)
    if idx is None:
        return None
    entries = struct.unpack(f'<{CHUNKS_PER_SHARD * 2}Q', idx[:-4])
    off, n = entries[2 * hour], entries[2 * hour + 1]
    if off == 2 ** 64 - 1:
        return None
    return gzip.decompress(shard.range(off, n))


COVERAGE_PREFIX = 'empty-v1p/coverage'
GAP_FRACTION = 0.5  # a minute is a "gap" when fewer than this fraction of the day's live stations were observed


def coverage_key(d: date) -> str:
    return f'{COVERAGE_PREFIX}/{d.strftime(ISO_DAY)}.json'


def coverage_doc(dp: DayPlanes) -> dict:
    """Fleet-wide observed-minute coverage for one day, from the `observed` plane: per-minute
    count of observed stations, the day's live-station count, and gap runs (`[start_minute,
    length, min_count]`) where fewer than `GAP_FRACTION` of live stations were observed. This
    is the "lost minutes" signal for the health page — it sees partial-feed minutes, which a
    poll-file count can't."""
    obs = dp.planes['observed']
    counts = obs.sum(1)
    live = int(obs.any(0).sum())
    gap = counts < GAP_FRACTION * live
    gaps = []
    t = 0
    while t < MINUTES_PER_DAY:
        if gap[t]:
            u = t
            while u < MINUTES_PER_DAY and gap[u]:
                u += 1
            gaps.append([int(t), int(u - t), int(counts[t:u].min())])
            t = u
        else:
            t += 1
    return {
        'day': dp.day.strftime(ISO_DAY),
        'live': live,
        'observed_minutes': int((~gap).sum()),
        'gaps': gaps,
        'counts': [int(c) for c in counts],
    }


def write_coverage(cli, dp: DayPlanes) -> dict:
    doc = coverage_doc(dp)
    cli.put_object(Bucket=BUCKET, Key=coverage_key(dp.day), Body=json.dumps(doc, separators=(',', ':')).encode(), ContentType='application/json')
    return doc


# ─── Layouts ──────────────────────────────────────────────────────────────

class Layout:
    name: str
    prefix: str

    def ensure(self, g) -> None: ...
    def write_day(self, g, dp: DayPlanes) -> int: ...
    def keys(self, d: date, shard: int, planes: tuple[str, ...] = PLANES) -> list[str]: ...
    def listing_prefix(self) -> str: ...
    def read_hour(self, shards: dict[str, object], hour: int, planes: tuple[str, ...] = PLANES) -> np.ndarray | None:
        """`(len(planes), 60, 512)` bool from per-key shard accessors (see `keys`); None if all absent."""
        ...

    def store_url(self) -> str:
        return f's3://{BUCKET}/{self.prefix}'

    @staticmethod
    def _array_kwargs(shape, chunks, shards, dims):
        from zarr.codecs import GzipCodec
        return dict(shape=shape, chunks=chunks, shards=shards, dtype='uint8', compressors=GzipCodec(level=6), fill_value=0, dimension_names=dims)

    def attrs(self) -> dict:
        return {
            'empty_bitmaps': 1,
            'layout': self.name,
            'epoch': EPOCH.isoformat(),
            'planes': list(PLANES),
            'bits': 'np.packbits along the station axis (station j → byte j//8, bit 7-j%8)',
            'vocab': VOCAB_KEY,
            'observed': 'is_installed==1 & is_renting==1 & !(bikes==0 & docks==0)',
        }


class Packed(Layout):
    name, prefix, array = 'packed', 'empty-v1p', 'planes'

    def ensure(self, g) -> None:
        if self.array not in g:
            g.create_array(name=self.array, **self._array_kwargs(
                (N_PLANES, T_MAX_DAYS * MINUTES_PER_DAY, S_BYTES), (N_PLANES, CHUNK_MINUTES, SHARD_BYTES),
                (N_PLANES, MINUTES_PER_DAY, SHARD_BYTES), ('plane', 'minute', 'station_byte'),
            ))

    def write_day(self, g, dp: DayPlanes) -> int:
        t0 = day_idx(dp.day) * MINUTES_PER_DAY
        packed = dp.stacked()
        g[self.array][:, t0:t0 + MINUTES_PER_DAY, :] = packed
        return int(sum(packed[:, :, j * SHARD_BYTES:(j + 1) * SHARD_BYTES].any() for j in range(N_SHARDS)))

    def keys(self, d: date, shard: int, planes: tuple[str, ...] = PLANES) -> list[str]:
        return [f'{self.prefix}/{self.array}/c/0/{day_idx(d)}/{shard}']

    def listing_prefix(self) -> str:
        return f'{self.prefix}/{self.array}/c/0/'

    def read_hour(self, shards, hour: int, planes: tuple[str, ...] = PLANES) -> np.ndarray | None:
        raw = hour_chunk_bytes(next(iter(shards.values())), hour)
        if raw is None:
            return None
        allp = np.unpackbits(np.frombuffer(raw, dtype=np.uint8).reshape(N_PLANES, CHUNK_MINUTES, SHARD_BYTES), axis=2).astype(bool)
        return allp[[PLANES.index(p) for p in planes]]


LAYOUTS = {L.name: L() for L in (Packed,)}


def open_store(url: str):
    """Zarr store: `s3://ctbk/<prefix>` on R2 or a local path."""
    from zarr.storage import FsspecStore, LocalStore
    if not url.startswith('s3://'):
        return LocalStore(url)
    import os
    return FsspecStore.from_url(url, storage_options={
        'key': os.environ['R2_ACCESS_KEY_ID'],
        'secret': os.environ['R2_SECRET_ACCESS_KEY'],
        'client_kwargs': {'endpoint_url': r2_endpoint(), 'region_name': 'auto'},
    })


def open_group(layout: Layout, store):
    import zarr
    g = zarr.open_group(store, mode='a')
    if not g.attrs.get('empty_bitmaps'):
        g.attrs.update(layout.attrs())
    layout.ensure(g)
    return g


def carry_from_r2(cli, layout: Layout, d: date, n_shards: int) -> np.ndarray:
    """The previous day's carry (`(3, S_MAX)` bool: filled state at its minute 1439) read from its
    shards' last hour chunk; zeros where the shard is absent."""
    seed = np.zeros((N_PLANES - 1, S_MAX), dtype=bool)
    for j in range(n_shards):
        blk = read_hour(cli, layout, d - timedelta(days=1), CHUNKS_PER_SHARD - 1, j)
        if blk is not None:
            seed[:, j * SHARD_STATIONS:(j + 1) * SHARD_STATIONS] = blk[1:, -1, :]
    return seed


def read_hour(cli, layout: Layout, d: date, hour: int, shard: int, planes=PLANES, fetch: Fetch | None = None) -> np.ndarray | None:
    shards = {'_': R2Shard(cli, layout.keys(d, shard, planes)[0], fetch)}
    return layout.read_hour(shards, hour, planes)


# ─── Query: the reference `/api/empty` ────────────────────────────────────

@dataclass
class QueryResult:
    stations: list[str]     # members with ≥1 observation in the window (the joint is over these)
    dropped: list[str]      # members never observed in the window (dead / not yet installed)
    planes: tuple[str, ...]
    ffill: int | None       # None = as stored (filled), 0 = strict (observed only), N = fill ≤N-minute gaps
    n_minutes: int          # minutes in the window with every member's state known
    pct: dict[str, dict[str, float]]   # plane → station → fraction of that station's known minutes
    k_of_n: dict[str, dict[int, int]]  # plane → k → minutes with exactly k members in that state
    fetch: Fetch
    seconds: float


def query(
    cli, layout: Layout, vocab: Vocab, stations: list[str],
    from_: date, to: date, hours: list[int], dows: list[int], tz: str,
    planes: tuple[str, ...] = PLANES[1:], strategy: str = 'range', workers: int = 16,
    ffill: int | None = None,
) -> QueryResult:
    """Strided-window query: local `hours` × `dows` over [from_, to] for a station set.
    `strategy`: `range` = index tail + one range GET per needed hour, per object;
    `whole` = one GET per object, index parsed locally.
    `ffill`: None = the stored (forward-filled) planes, every minute known; 0 = strict, only
    observed minutes count; N = filled bits kept only within ≤N consecutive unobserved minutes
    (run length measured within the assembled window, so approximate at its hour boundaries)."""
    need = tuple(p for p in PLANES if p == 'observed' or p in planes)
    zone = ZoneInfo(tz)
    # (utc_day, utc_hour) pairs whose local start lies in the requested hours × dows
    wanted: dict[date, list[int]] = {}
    t = datetime.combine(from_, datetime.min.time(), tzinfo=timezone.utc) - timedelta(days=1)
    end = datetime.combine(to, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=2)
    while t < end:
        loc = t.astimezone(zone)
        if from_ <= loc.date() <= to and loc.hour in hours and loc.weekday() in dows:
            wanted.setdefault(t.date(), []).append(t.hour)
        t += timedelta(hours=1)
    cols = {s: vocab.index[s] for s in stations}
    shards = sorted({c // SHARD_STATIONS for c in cols.values()})
    fetch = Fetch()
    t_start = time.time()

    def task(d: date, shard: int) -> list[tuple[int, np.ndarray | None]]:
        keys = layout.keys(d, shard, need)
        names = ('_',)
        if strategy == 'whole':
            acc = {}
            for n, k in zip(names, keys):
                b = R2Shard(cli, k, fetch).whole()
                acc[n] = BytesShard(b) if b is not None else _Absent()
        else:
            acc = {n: R2Shard(cli, k, fetch) for n, k in zip(names, keys)}
        return [(h, layout.read_hour(acc, h, need)) for h in wanted[d]]

    with ThreadPoolExecutor(workers) as ex:
        futs = {(d, j): ex.submit(task, d, j) for d in wanted for j in shards}
        chunks = {k: f.result() for k, f in futs.items()}
    # Assemble per-station minute series over the window
    series = {p: {s: [] for s in stations} for p in need}
    for d in sorted(wanted):
        by_shard = {j: dict(chunks[(d, j)]) for j in shards}
        for h in wanted[d]:
            for s, c in cols.items():
                blk = by_shard[c // SHARD_STATIONS].get(h)
                col = c % SHARD_STATIONS
                for i, p in enumerate(need):
                    series[p][s].append(blk[i, :, col] if blk is not None else np.zeros(CHUNK_MINUTES, bool))
    S = {p: {s: np.concatenate(v) for s, v in d_.items()} for p, d_ in series.items()}
    obs = np.stack([S['observed'][s] for s in stations])          # (K, T)
    live = obs.any(1)
    dropped = [s for s, l in zip(stations, live) if not l]
    members = [s for s, l in zip(stations, live) if l]
    obs = obs[live]
    T = obs.shape[1]
    if ffill is None:
        known = np.ones_like(obs)
    elif ffill == 0:
        known = obs
    else:
        last = np.maximum.accumulate(np.where(obs, np.arange(T)[None, :], -1), axis=1)
        known = obs | ((last >= 0) & (np.arange(T)[None, :] - last <= ffill))
    all_known = known.all(0)
    pct, k_of_n = {}, {}
    for p in planes:
        st = np.stack([S[p][s] for s in members]) & known
        pct[p] = {s: float(st[i].sum() / max(known[i].sum(), 1)) for i, s in enumerate(members)}
        k = st[:, all_known].sum(0)
        k_of_n[p] = {int(i): int(n) for i, n in zip(*np.unique(k, return_counts=True))}
    return QueryResult(members, dropped, planes, ffill, int(all_known.sum()), pct, k_of_n, fetch, time.time() - t_start)


class _Absent:
    def tail(self, n): return None
    def range(self, off, n): raise AssertionError


# ─── CLI ──────────────────────────────────────────────────────────────────

@gbfs.group('empty', help='Empty/full station bitmaps (`empty-v1*/` Zarr on R2; `specs/avail-empty-bitmaps.md`).')
def empty() -> None:
    pass


def _parse_day(s: str) -> date:
    return date.fromisoformat(s)


def _status_days(cli) -> list[date]:
    # `Delimiter` keeps the per-minute WAL JSONs under `gbfs/status/<day>/` out of the listing
    # (they're ~1,440 keys/day); the daily parquets are direct children of the prefix.
    pag = cli.get_paginator('list_objects_v2')
    days = []
    for page in pag.paginate(Bucket=BUCKET, Prefix=f'{STATUS_PREFIX}/', Delimiter='/'):
        for o in page.get('Contents', []):
            k = o['Key']
            if k.endswith('.parquet'):
                days.append(date.fromisoformat(k.split('/')[-1][:-8]))
    return sorted(days)


def _shards_by_day(cli, layout: Layout) -> dict[date, set[int]]:
    pag = cli.get_paginator('list_objects_v2')
    out: dict[date, set[int]] = {}
    for page in pag.paginate(Bucket=BUCKET, Prefix=layout.listing_prefix()):
        for o in page.get('Contents', []):
            parts = o['Key'].split('/')
            out.setdefault(day_of_idx(int(parts[-2])), set()).add(int(parts[-1]))
    return out


def _built_days(cli, layout: Layout, n_shards: int) -> set[date]:
    """Days whose first `n_shards` station-shards all exist. A day interrupted mid-`write_day`
    reads as unbuilt and gets redone (writes are idempotent)."""
    return {d for d, s in _shards_by_day(cli, layout).items() if set(range(n_shards)) <= s}


cache_opt = option('-c', '--cache', type=Path, default=DEFAULT_CACHE, help=f'Local cache dir for daily status parquets (default {DEFAULT_CACHE})')
no_cache_opt = option('-C', '--no-cache', is_flag=True, help='Stream daily status parquets from R2 without caching them locally')
layout_opt = option('-L', '--layout', type=Choice(list(LAYOUTS)), default='packed', help='Bitmap layout')
store_opt = option('-s', '--store', default=None, help="Zarr store URL: `s3://…` (default: the layout's R2 prefix) or a local path")


@empty.command('vocab', help='Create the station vocab (`empty-v1/stations.json`) from `station-luc.json`, ordered by s2 cell id. No-op if it exists (`-f` to overwrite; only safe before any shards are written).')
@option('-f', '--force', is_flag=True)
def vocab_cmd(force: bool) -> None:
    cli = r2_client()
    if (v := load_vocab(cli)) and not force:
        err(f"vocab exists: {len(v.stations)} stations (`-f` to overwrite)")
        return
    v = init_vocab(cli)
    save_vocab(cli, v)
    err(f"wrote {VOCAB_KEY}: {len(v.stations)} stations")


def _build_days(layout: Layout, days: list[date], cache: Path | None, store: str | None, force: bool, verify: bool) -> None:
    cli = r2_client()
    vocab = load_vocab(cli)
    if vocab is None:
        vocab = init_vocab(cli)
        save_vocab(cli, vocab)
        err(f"initialized vocab: {len(vocab.stations)} stations")
    built = set() if force else _built_days(cli, layout, vocab.n_shards)
    g = open_group(layout, open_store(store or layout.store_url()))
    prev: DayPlanes | None = None
    for d in days:
        if d in built:
            err(f"{layout.name} {d}: built, skipping")
            prev = None
            continue
        df = load_status_day(cli, d, cache)
        if prev is not None and prev.day == d - timedelta(days=1):
            seed = prev.carry
        else:
            seed = carry_from_r2(cli, layout, d, vocab.n_shards)
        dp = build_planes(df, d, vocab, seed)
        prev = dp
        if dp.added:
            save_vocab(cli, vocab)
            err(f"{d}: vocab += {len(dp.added)} stations → {len(vocab.stations)}")
        n_objs = layout.write_day(g, dp)
        cov = write_coverage(cli, dp)
        obs = dp.planes['observed']
        n_obs = int(obs.sum())
        dens = {p: int(dp.strict(p).sum()) / max(n_obs, 1) for p in PLANES[1:]}
        err(
            f"{layout.name} {d}: rows={dp.n_rows:,} spill={dp.n_spill} observed={n_obs:,} "
            + ' '.join(f"{p}={v:.1%}" for p, v in dens.items())
            + f" objects={n_objs} coverage={cov['observed_minutes']}/1440 gaps={len(cov['gaps'])}"
        )
        if verify:
            _verify_day(cli, layout, dp)


def _verify_day(cli, layout: Layout, dp: DayPlanes, hour: int = 8) -> None:
    """Round-trip: range-read one hour of every station-shard via the reference reader, compare to the built planes."""
    n = 0
    for j in range(N_SHARDS):
        expect = dp.hour(hour, j)
        got = read_hour(cli, layout, dp.day, hour, j)
        if got is None:
            if expect.any():
                raise RuntimeError(f"{dp.day} shard {j} hour {hour}: absent but expected {int(expect.sum())} bits")
            continue
        if not np.array_equal(got, expect):
            raise RuntimeError(f"{dp.day} shard {j} hour {hour}: mismatch ({int((got != expect).sum())} bits)")
        n += 1
    err(f"{layout.name} {dp.day}: verified {n} range-read shards (hour {hour}, all planes) against built planes")


@empty.command('build', help='Build one or more days (`YYYY-MM-DD`) from the daily status parquets into the Zarr day-shards.')
@cache_opt
@no_cache_opt
@option('-f', '--force', is_flag=True, help='Rebuild even if the day already has shards')
@layout_opt
@store_opt
@option('-V', '--verify', is_flag=True, help='After writing, range-read one hour of every shard via the reference reader and compare')
@argument('days', nargs=-1, required=True)
def build_cmd(cache: Path, no_cache: bool, force: bool, layout: str, store: str | None, verify: bool, days: tuple[str, ...]) -> None:
    _build_days(LAYOUTS[layout], [_parse_day(d) for d in days], None if no_cache else cache, store, force, verify)


@empty.command('backfill', help='Build every day with a daily status parquet on R2 that has no (or incomplete) shards yet, oldest first (default: through yesterday).')
@cache_opt
@no_cache_opt
@option('-f', '--from', 'from_', default=None, help='First day (default: first status parquet)')
@option('-F', '--force', is_flag=True, help='Rebuild days that already have shards')
@layout_opt
@store_opt
@option('-t', '--to', default=None, help='Last day, inclusive (default: yesterday UTC)')
@option('-V', '--verify', is_flag=True)
def backfill_cmd(cache: Path, no_cache: bool, from_: str | None, force: bool, layout: str, store: str | None, to: str | None, verify: bool) -> None:
    cli = r2_client()
    days = _status_days(cli)
    lo = _parse_day(from_) if from_ else days[0]
    hi = _parse_day(to) if to else (datetime.now(timezone.utc).date() - timedelta(days=1))
    days = [d for d in days if lo <= d <= hi]
    err(f"backfill {layout}: {len(days)} candidate days {days[0]} → {days[-1]}")
    _build_days(LAYOUTS[layout], days, None if no_cache else cache, store, force, verify)


@empty.command('verify', help='Per layout: days with a daily status parquet but missing/partial shards (through yesterday), and shard-days with no source parquet.')
@option('-L', '--layout', type=Choice(list(LAYOUTS)), default=None, help='Default: all layouts')
def verify_cmd(layout: str | None) -> None:
    cli = r2_client()
    vocab = load_vocab(cli)
    n_shards = vocab.n_shards if vocab else N_SHARDS
    hi = datetime.now(timezone.utc).date() - timedelta(days=1)
    src = {d for d in _status_days(cli) if d <= hi}
    for L in ([LAYOUTS[layout]] if layout else LAYOUTS.values()):
        by_day = _shards_by_day(cli, L)
        built = {d for d, s in by_day.items() if set(range(n_shards)) <= s}
        partial = {d for d in by_day if d not in built}
        missing = sorted(src - built)
        extra = sorted(built - src)
        print(f"{L.name}: status days ≤ {hi}: {len(src)}  built: {len(built)}  missing: {len(missing)}  partial: {len(partial)}  extra: {len(extra)}")
        for d in missing:
            print(f"  missing {d}" + (f" (partial: shards {sorted(by_day[d])})" if d in partial else ''))
        for d in extra:
            print(f"  extra   {d}")


@empty.command('stats', help='Density (per plane, per-station quantiles) over the given days; `-e` adds the packbits/gzip inner-chunk encoding table (incl. separate vs packed planes).')
@cache_opt
@no_cache_opt
@option('-e', '--encoding', is_flag=True, help='Also report bytes/chunk + ratios for candidate inner-chunk shapes')
@argument('days', nargs=-1, required=True)
def stats_cmd(cache: Path, no_cache: bool, encoding: bool, days: tuple[str, ...]) -> None:
    cli = r2_client()
    vocab = load_vocab(cli) or init_vocab(cli)
    ds = [_parse_day(d) for d in days]
    acc = {p: [] for p in PLANES}
    for d in ds:
        dp = build_planes(load_status_day(cli, d, None if no_cache else cache), d, vocab)
        for p in PLANES:
            acc[p].append(dp.planes[p])
    A = {p: np.concatenate(acc[p]) for p in PLANES}
    S = len(vocab.stations)
    obs = A['observed'][:, :S]
    n_obs = obs.sum()
    T = obs.shape[0]
    print(f"days={len(ds)} minutes={T} stations={S} observed station-minutes={n_obs:,} / {T * S:,} = {n_obs / (T * S):.1%}")
    live = obs.sum(0) > 0
    for p in PLANES[1:]:
        a = A[p][:, :S] & obs
        ps = (a.sum(0) / np.maximum(obs.sum(0), 1))[live]
        q = np.quantile(ps, [.1, .25, .5, .75, .9, .99])
        print(f"{p:10s} overall={a.sum() / n_obs:6.2%}   per-station p10/25/50/75/90/99 = "
              + ' '.join(f"{x:5.1%}" for x in q) + f"   stations>50%: {(ps > .5).sum()}")
    if not encoding:
        return
    print(f"\n{'plane':10s} {'shape':>12s} {'n':>5s} {'packed':>8s} {'gzip':>8s} {'ratio':>6s}")
    for p in PLANES:
        for (h, w) in [(60, 512), (240, 512), (1440, 512), (60, S_MAX), (1440, S_MAX)]:
            n = packed = gz = 0
            for i in range(0, T - h + 1, h):
                for j in range(0, S_MAX, w):
                    b = np.packbits(A[p][i:i + h, j:j + w], axis=1).tobytes()
                    packed += len(b); gz += len(zlib.compress(b, 6)); n += 1
            print(f"{p:10s} {str((h, w)):>12s} {n:5d} {packed / n:8.0f} {gz / n:8.0f} {packed / gz:6.1f}x")
    n = sep = cat = 0
    for i in range(0, T - CHUNK_MINUTES + 1, CHUNK_MINUTES):
        for j in range(0, S_MAX, SHARD_STATIONS):
            bs = [np.packbits(A[p][i:i + CHUNK_MINUTES, j:j + SHARD_STATIONS], axis=1).tobytes() for p in PLANES]
            if not any(bs[0]):
                continue
            n += 1; sep += sum(len(zlib.compress(b, 6)) for b in bs); cat += len(zlib.compress(b''.join(bs), 6))
    print(f"\nall-planes chunk (4,60,512): separate-plane sum={sep / n:.0f} B  plane-major packed={cat / n:.0f} B ({cat / sep:.2f}×)")


@empty.command('read', help='Reference range-read (no zarr): one hour of all four planes for the given station ids, straight from the shard object(s). Prints per-station set-bit counts.')
@option('-d', '--day', required=True, help='YYYY-MM-DD (UTC)')
@option('-H', '--hour', type=int, required=True, help='UTC hour 0-23')
@layout_opt
@argument('stations', nargs=-1, required=True)
def read_cmd(day: str, hour: int, layout: str, stations: tuple[str, ...]) -> None:
    cli = r2_client()
    L = LAYOUTS[layout]
    vocab = load_vocab(cli)
    if vocab is None:
        raise RuntimeError("no vocab on R2")
    d = _parse_day(day)
    by_shard: dict[int, list[str]] = {}
    for s in stations:
        by_shard.setdefault(vocab.index[s] // SHARD_STATIONS, []).append(s)
    fetch = Fetch()
    print('station\t' + '\t'.join(PLANES))
    for shard, ss in sorted(by_shard.items()):
        chunk = read_hour(cli, L, d, hour, shard, fetch=fetch)
        for s in ss:
            col = vocab.index[s] % SHARD_STATIONS
            counts = [int(chunk[i, :, col].sum()) if chunk is not None else 0 for i in range(N_PLANES)]
            print(s + '\t' + '\t'.join(str(c) for c in counts))
    err(f"{L.name}: {fetch.rpcs} RPCs, {fetch.nbytes:,} B")


def _query_opts(f):
    for o in reversed([
        option('-d', '--dows', default='0,1,2,3,4', help='Local days of week, 0=Mon (default weekdays)'),
        option('-F', '--ffill', type=int, default=None, help='Fill horizon in minutes: omit = as stored (forward-filled), 0 = strict (observed minutes only), N = fill gaps ≤N minutes'),
        option('-f', '--from', 'from_', required=True, help='First local day, YYYY-MM-DD'),
        option('-H', '--hours', default='8', help='Local hours of day, comma-separated (default 8 = 8–9am)'),
        option('-p', '--planes', default='no_bikes,no_ebikes,full', help='Condition planes to report (observed is always fetched)'),
        option('-t', '--to', required=True, help='Last local day, inclusive'),
        option('-w', '--workers', type=int, default=16, help='Parallel fetches (the worker fans out similarly)'),
        option('-z', '--tz', default='America/New_York'),
        argument('stations', nargs=-1, required=True),
    ]):
        f = o(f)
    return f


def _print_result(r: QueryResult) -> None:
    if r.dropped:
        print(f"dropped (never observed in window): {' '.join(r.dropped)}")
    fill = 'as stored (forward-filled)' if r.ffill is None else ('strict' if r.ffill == 0 else f'ffill ≤{r.ffill}m')
    print(f"minutes with all {len(r.stations)} stations known [{fill}]: {r.n_minutes:,}")
    for p in r.planes:
        print(f"{p}:")
        for s in r.stations:
            print(f"  {s}\t{r.pct[p][s]:.1%}")
        K = len(r.stations)
        dist = '  '.join(f"{k}/{K}: {r.k_of_n[p].get(k, 0) / max(r.n_minutes, 1):.1%}" for k in range(K + 1))
        print(f"  k-of-{K} (all observed): {dist}")


@empty.command('query', help='Reference `/api/empty`: strided window (local hours × days-of-week over [from, to]) for a station set → per-station % in each condition + the k-of-K joint distribution. Prints RPC/byte/time budget to stderr.')
@layout_opt
@option('-S', '--strategy', type=Choice(['range', 'whole']), default='range', help='`range`: index tail + range GET per hour; `whole`: one GET per object')
@_query_opts
def query_cmd(layout: str, strategy: str, ffill: int | None, dows: str, from_: str, hours: str, planes: str, to: str, workers: int, tz: str, stations: tuple[str, ...]) -> None:
    cli = r2_client()
    vocab = load_vocab(cli)
    r = query(
        cli, LAYOUTS[layout], vocab, list(stations), _parse_day(from_), _parse_day(to),
        [int(h) for h in hours.split(',')], [int(x) for x in dows.split(',')], tz,
        tuple(planes.split(',')), strategy, workers, ffill,
    )
    _print_result(r)
    err(f"{layout}/{strategy}: {r.fetch.rpcs} RPCs, {r.fetch.nbytes:,} B, {r.seconds:.2f}s ({workers} workers)")


@empty.command('bench', help='Run the same query under every layout × fetch strategy × {all planes, one plane}; assert identical answers; print RPCs / bytes / wall time.')
@option('-n', '--repeat', type=int, default=3, help='Runs per cell (best-of)')
@_query_opts
def bench_cmd(repeat: int, ffill: int | None, dows: str, from_: str, hours: str, planes: str, to: str, workers: int, tz: str, stations: tuple[str, ...]) -> None:
    cli = r2_client()
    vocab = load_vocab(cli)
    hs, ds = [int(h) for h in hours.split(',')], [int(x) for x in dows.split(',')]
    ref = None
    print(f"{'layout':9s} {'strategy':8s} {'planes':8s} {'RPCs':>6s} {'KB':>8s} {'best s':>7s} {'median s':>9s}")
    for L in LAYOUTS.values():
        for strategy in ('range', 'whole'):
            for pl in (tuple(planes.split(',')), ('no_bikes',)):
                times = []
                for _ in range(repeat):
                    r = query(cli, L, vocab, list(stations), _parse_day(from_), _parse_day(to), hs, ds, tz, pl, strategy, workers, ffill)
                    times.append(r.seconds)
                key = (r.n_minutes, {p: r.pct[p] for p in pl}, {p: r.k_of_n[p] for p in pl})
                if pl == tuple(planes.split(',')):
                    if ref is None:
                        ref = key
                    elif key != ref:
                        raise RuntimeError(f"answer mismatch for {L.name}/{strategy}")
                times.sort()
                print(f"{L.name:9s} {strategy:8s} {('all' if len(pl) > 1 else pl[0]):8s} {r.fetch.rpcs:6d} {r.fetch.nbytes / 1e3:8.1f} {times[0]:7.2f} {times[len(times) // 2]:9.2f}")
    print()
    _print_result(r)
