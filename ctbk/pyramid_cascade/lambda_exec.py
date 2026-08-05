"""Lambda-executor cascade — thin wrapper over `pyrmts_engine.consolidate`
(moved upstream, ops-adoption phase 2: pyrmts `specs/pyrmts-ops-adoption.md`;
originally `specs/avail-v3-lambda-cascade.md`).

ctbk residue — the GBFS "business logic" the upstream seams take as
injections:

- `_fill_hole_raw`: finest-tier hole fill from the raw per-minute WAL
  (station-chain expansion + histogram accumulation + the poller
  finality policy) — plugged in as `consolidate`'s `raw_fill` strategy.
- The station-chain machinery (`chains:` mode, LUC vs frozen-vocab) that
  `_fill_hole_raw` expands observations through.
- Registration routing: `d1_http.ProxyShardIndex` (worker-binding proxy
  when configured — the 2026-07-28 D1 split-brain workaround) instead of
  upstream's direct-REST `D1ShardIndex`.
- `AVAIL_SORT = (s2_cell, dt)`: cell-first shard sort (station queries
  RG-prune on cell), matching the engine builds (`engine_check.run_build`
  passes the same) — byte-compat with the existing avail-v5 pyramid.

Cross-tier hole fills use upstream's generic monoid `cross_tier_rebin`
(regression-locked to engine-canonical bytes). Runs identically on a
laptop (`ctbk gbfs lambda fill`) and in the AWS Lambda handler
(`gbfs/lambda/handler.py`, container image — polars available).
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import yaml as _yaml
from pyrmts import ExpectedShard, parse_pyramid_yaml, pyramid_from_config
from pyrmts import merge_lambda_shards as _merge_cfg
from pyrmts_engine.consolidate import (  # noqa: F401  (re-exports)
    RawHoleFill,
    encode_gap,
    materialize_extension_shard,
    overlap_cover as _overlap_cover,
    tile_from_existing as _tile_from_existing,
)
from pyrmts_engine.consolidate import decode_gap as _decode_gap
from pyrmts_engine.consolidate import run_extension_fill as _run_extension_fill
from pyrmts_engine.consolidate import run_single_gap as _run_single_gap
from pyrmts_engine.materialize import MaterializeResult, shard_key as _shard_key, source_tier_for as _source_tier_for  # noqa: F401
from utz import err

from .lite import AVAIL_GENESIS, R2_BUCKET, dur_min

# Cell-first sort: station queries RG-prune on `s2_cell`. The pyrmts
# writer default is bin-first — must be overridden everywhere avail
# shards are written (engine builds pass the same).
AVAIL_SORT = ['s2_cell', 'dt']


def parse_lambda_shards(yaml_text: str) -> dict[str, list[str]]:
    """`{tier_name: [extension rungs]}` for tiers declaring `lambda_shards`."""
    raw = _yaml.safe_load(yaml_text)
    out: dict[str, list[str]] = {}
    for t in raw.get('tiers') or []:
        ext = t.get('lambda_shards')
        if ext:
            out[t['name']] = [str(d) for d in ext]
    return out


def merge_lambda_shards(yaml_text: str) -> str:
    """YAML-text form of `pyrmts.merge_lambda_shards` (each tier's
    `shards` extended by its `lambda_shards`, divisibility-chain
    enforced) — for call sites that thread config as text."""
    raw = _yaml.safe_load(yaml_text)
    for t in raw.get('tiers') or []:
        ext = t.pop('lambda_shards', None)
        if not ext:
            continue
        shards = list(t['shards'])
        prev = dur_min(str(shards[-1]))
        for d in ext:
            cur = dur_min(str(d))
            if cur % prev != 0 or cur <= prev:
                raise ValueError(
                    f"tier {t['name']}: lambda_shards {d} breaks the "
                    f"divisibility chain after {shards[-1]}")
            shards.append(str(d))
            prev = cur
        t['shards'] = shards
    return _yaml.safe_dump(raw, sort_keys=False)


RAW_MINUTE_PREFIX = 'gbfs/avail/agg=1m/cons=1m'
STATION_LUC_KEY = 'station-luc.json'
COARSEST_LEVEL = 10
# Anti-race damper for the currently-closing period: a WAL put can be
# seconds in flight, so a missing minute younger than this defers the
# build one tick. Beyond it, build with whatever minutes exist — an
# absent minute is just absent (patchy raw data is an invariant), and a
# datum that lands late repairs via the invalidation journal
# (`specs/shard-invalidation-adoption.md`) instead of a wait/skip
# heuristic. Same policy as the CFW cascade's `CRON_JITTER_GRACE_MS`.
CRON_JITTER_GRACE_S = 120

# Chain mode: 'luc' (legacy avail-v3 — L10..LUC ancestor chains from the
# station-luc denorm) or 'vocab' (avail-v4 — frozen ragged vocabulary +
# `s:<short_name>` identity keys; `specs/drop-luc-station-keys.md`).
# Selected per-run from the pyramid config's top-level `chains:` key.
_chains_mode = 'luc'


def parse_chains_mode(yaml_text: str) -> str:
    return _yaml.safe_load(yaml_text).get('chains') or 'luc'


def set_chains_mode(mode: str) -> None:
    global _chains_mode
    if mode not in ('luc', 'vocab'):
        raise ValueError(f'unknown chains mode {mode!r}')
    _chains_mode = mode


def _chains(r2, fetched_after: datetime | None = None) -> dict[str, list[str]]:
    return (_vocab_chains if _chains_mode == 'vocab' else _luc_chains)(r2, fetched_after)


def _find_vocab_file() -> Path:
    """`station-vocab.json`: at the Lambda bundle root (alongside
    `handler.py`/`avail.yaml`) or under the repo's `configs/pyramids/`."""
    root = Path(__file__).parents[2]
    for p in (root / 'station-vocab.json', root / 'configs/pyramids/station-vocab.json'):
        if p.exists():
            return p
    raise FileNotFoundError('station-vocab.json (bundle root or configs/pyramids/)')


_vocab_chains_cache: tuple[datetime, dict[str, list[str]]] | None = None


def _vocab_chains(r2, fetched_after: datetime | None = None) -> dict[str, list[str]]:
    """UUID → [frozen-vocab ancestor cells + `s:<short_name>`]. Registry
    (uuid ↔ short_name + lat/lng) from the same R2 denorm file as the
    LUC path — only its stable identity fields are read; the frozen
    vocabulary comes from the bundled `station-vocab.json`, so new
    stations can never churn existing keys."""
    global _vocab_chains_cache
    if _vocab_chains_cache is not None and fetched_after is not None \
            and _vocab_chains_cache[0] < fetched_after:
        _vocab_chains_cache = None
    if _vocab_chains_cache is None:
        import json as _json
        from .vocab import load_vocab, station_chain
        vocab = load_vocab(_find_vocab_file())
        obj = r2.get_object(Bucket=R2_BUCKET, Key=STATION_LUC_KEY)
        data = _json.loads(obj['Body'].read())
        chains: dict[str, list[str]] = {}
        for uuid, short_name in data['by_uuid'].items():
            e = data['by_short_name'].get(short_name)
            if not e:
                continue
            chains[uuid] = station_chain(e['lat'], e['lng'], short_name, vocab)
        _vocab_chains_cache = (datetime.now(timezone.utc), chains)
    return _vocab_chains_cache[1]


# (fetched_at, chains) — see `fetched_after` below.
_luc_chains_cache: tuple[datetime, dict[str, list[str]]] | None = None


def _luc_chains(r2, fetched_after: datetime | None = None) -> dict[str, list[str]]:
    """UUID → [ancestor cells L10..LUC) + LUC anchor] (mirrors the CFW's
    `buildChains` / avail_v3's `build_1m_hour_table`). Cached per
    process (one fetch per Lambda container / local run).

    `fetched_after`: refetch if the cached copy predates this timestamp.
    A warm Lambda container can outlive a denorm re-key; a stale-content
    rebuild (`stale_before`) must not re-expand stations through the OLD
    chains it cached before the re-key."""
    global _luc_chains_cache
    if _luc_chains_cache is not None and fetched_after is not None \
            and _luc_chains_cache[0] < fetched_after:
        _luc_chains_cache = None
    if _luc_chains_cache is None:
        import json as _json
        import s2cell
        obj = r2.get_object(Bucket=R2_BUCKET, Key=STATION_LUC_KEY)
        data = _json.loads(obj['Body'].read())
        chains: dict[str, list[str]] = {}
        for uuid, short_name in data['by_uuid'].items():
            e = data['by_short_name'].get(short_name)
            if not e:
                continue
            chain = [s2cell.lat_lon_to_token(e['lat'], e['lng'], lvl)
                     for lvl in range(COARSEST_LEVEL, e['level'])]
            chain.append(e['cell'])
            chains[uuid] = chain
        _luc_chains_cache = (datetime.now(timezone.utc), chains)
    return _luc_chains_cache[1]


def _fill_hole_raw(
    r2,
    pyramid,
    hole: tuple[datetime, datetime],
    now: datetime,
) -> pa.Table | None:
    """Finest-tier hole-fill from the raw per-minute WAL: LUC-expand each
    station observation, accumulate histograms per (cell, dt, metric).
    Builds with whatever minutes exist; only a missing minute younger
    than `CRON_JITTER_GRACE_S` returns None (retry next run — the WAL
    put may be in flight). Late-landing data repairs built shards via
    the invalidation journal. Mirrors the CFW's `readRawRows` policy."""
    import json as _json
    from datetime import timedelta
    from collections import defaultdict
    chains = _chains(r2)
    metrics = [m.name for m in pyramid.metrics]
    accum: dict[tuple[str, int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    s, e = hole
    saw_any = False
    cur = s
    while cur < e:
        key = f"{RAW_MINUTE_PREFIX}/{cur:%Y-%m-%d}/{cur:%H%M}.parquet"
        try:
            obj = r2.get_object(Bucket=R2_BUCKET, Key=key)
        except r2.exceptions.ClientError:
            if (now - cur).total_seconds() < CRON_JITTER_GRACE_S:
                return None  # WAL put may be in flight — retry next run
            cur += timedelta(minutes=1)
            continue
        saw_any = True
        tab = pq.read_table(io.BytesIO(obj['Body'].read()))
        d = tab.select(['station_id', 'dt'] + [f'{m}_sum' for m in metrics]).to_pydict()
        for i, sid in enumerate(d['station_id']):
            chain = chains.get(sid)
            if chain is None:
                continue
            dt_ms = int(d['dt'][i]) * 1000  # raw dt is SECONDS
            for m in metrics:
                v = d[f'{m}_sum'][i]
                if v is None:
                    continue
                state = str(int(v))
                for cell in chain:
                    accum[(cell, dt_ms, m)][state] += 1
        cur += timedelta(minutes=1)
    if not saw_any or not accum:
        # Nothing scraped in this span (all missed, past finality) —
        # treat as empty rather than unfillable.
        return pa.table({
            's2_cell': pa.array([], pa.string()), 'dt': pa.array([], pa.int64()),
            **{m: pa.array([], pa.string()) for m in metrics},
        })
    rows: dict[tuple[str, int], dict[str, str]] = {}
    for (cell, dt_ms, m), hist in accum.items():
        sorted_hist = dict(sorted(hist.items(), key=lambda kv: int(kv[0])))
        rows.setdefault((cell, dt_ms), {})[m] = _json.dumps(sorted_hist, separators=(',', ':'))
    keys = list(rows)
    arrays: dict[str, pa.Array] = {
        's2_cell': pa.array([k[0] for k in keys], pa.string()),
        'dt': pa.array([k[1] for k in keys], pa.int64()),
    }
    for m in metrics:
        arrays[m] = pa.array([rows[k].get(m) for k in keys], pa.string())
    return pa.table(arrays)


def _build_context(config_yaml: str):
    """(pyramid, raw_fill) for the consolidate seams: merged-ladder
    pyramid + the GBFS raw-WAL hole-fill closed over an R2 client."""
    from .lite import r2_client
    from .storage import storage_from_cfg

    set_chains_mode(parse_chains_mode(config_yaml))
    cfg = _merge_cfg(parse_pyramid_yaml(config_yaml))
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    r2 = r2_client()

    def raw_fill(hole: tuple[datetime, datetime], now: datetime) -> pa.Table | None:
        return _fill_hole_raw(r2, pyramid, hole, now)

    return pyramid, r2, raw_fill


def build_lambda_app(
    config_yaml: str,
    pyramid_name: str,
    event: dict | None = None,
):
    """`pyrmts_ops.LambdaApp` for one GBFS pyramid config — the consumer
    seam `pyrmts_ops.lambda_entry` dispatches through. Wires the raw-WAL
    hole fill, the proxy-aware registry, the cell-first sort, and the GC
    registry; refreshes the chains cache when the event carries
    `stale_before` (warm containers may cache pre-re-key chains)."""
    import os
    from pyrmts_ops import LambdaApp
    from pyrmts_ops.gc import D1GcRegistry
    from .d1_http import _db
    from .gc import RAW_PREFIX

    pyramid, r2, raw_fill = _build_context(config_yaml)
    sb = (event or {}).get('stale_before')
    if sb:
        _chains(r2, fetched_after=datetime.fromisoformat(sb))
    return LambdaApp(
        pyramid=pyramid,
        pyramid_name=pyramid_name,
        genesis=AVAIL_GENESIS,
        # No registration from the Lambda: the api worker's cron is the
        # sole registrar (expected-cover ∩ R2 − registered, ≤1 min lag),
        # so the Lambda is a pure R2 compute node — no D1 write path, no
        # split-brain exposure. Correctness: GC grace (15 min) exceeds
        # registration lag, so a not-yet-registered coarse tile's finer
        # tiles keep serving until its row lands.
        shard_index=None,
        raw_fill=raw_fill,
        sort=AVAIL_SORT,
        fill_all=os.environ.get('FILL_ALL') == '1',
        gc_registry=D1GcRegistry(database_id=_db(None)),
        gc_raw_prefixes=(RAW_PREFIX,),
    )


def run_extension_fill(
    config_yaml: str,
    *,
    now: datetime | None = None,
    fill_limit: int | None = None,
    time_budget_s: float | None = None,
    register: bool = False,
    dry_run: bool = False,
    fill_all: bool = False,
    pyramid_name: str = 'avail',
    stale_before: datetime | None = None,
) -> list[MaterializeResult]:
    """Discover + fill missing extension-rung shards over [genesis, now)
    — the cron tick / catch-up driver. With `register`, each `wrote` is
    registered (via the proxy-aware `ProxyShardIndex`) immediately after
    its put, and the historical write-then-die window is reconciled
    first.

    `stale_before`: shards last-modified before this UTC timestamp are
    treated as missing and rebuilt in place (content invalidation, e.g.
    a station-luc re-key — see `specs/done/avail-v3-lambda-rebuild.md`).
    The steady-state EventBridge tick never sets it."""
    from .d1_http import ProxyShardIndex

    if not parse_lambda_shards(config_yaml):
        raise ValueError('config declares no lambda_shards')
    pyramid, r2, raw_fill = _build_context(config_yaml)
    if stale_before is not None:
        # A warm container's cached station-luc chains may predate the
        # re-key that made these shards stale; refresh before any raw
        # hole-fill expands stations through old anchors.
        _chains(r2, fetched_after=stale_before)
    return _run_extension_fill(
        pyramid,
        genesis=AVAIL_GENESIS,
        pyramid_name=pyramid_name,
        now=now,
        shard_index=ProxyShardIndex(pyramid_name) if register else None,
        reconcile=register,
        fill_limit=fill_limit,
        time_budget_s=time_budget_s,
        dry_run=dry_run,
        fill_all=fill_all,
        stale_before=stale_before,
        sort=AVAIL_SORT,
        raw_fill=raw_fill,
    )


def run_single_gap(
    config_yaml: str,
    gap: ExpectedShard,
    *,
    stale_before: datetime | None = None,
    register: bool = True,
    pyramid_name: str = 'avail',
) -> MaterializeResult:
    """Materialize ONE shard (no discovery loop) — the handler branch the
    fan-out driver invokes concurrently."""
    from .d1_http import ProxyShardIndex

    pyramid, r2, raw_fill = _build_context(config_yaml)
    if stale_before is not None:
        _chains(r2, fetched_after=stale_before)
    return _run_single_gap(
        pyramid, gap,
        genesis=AVAIL_GENESIS,
        pyramid_name=pyramid_name,
        shard_index=ProxyShardIndex(pyramid_name) if register else None,
        stale_before=stale_before,
        sort=AVAIL_SORT,
        raw_fill=raw_fill,
    )


def decode_gap(d: dict) -> ExpectedShard:
    """Event payload → `ExpectedShard` (genesis-clipped effective bounds)."""
    return _decode_gap(d, AVAIL_GENESIS)
