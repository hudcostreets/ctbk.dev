"""Lambda-executor cascade: ladder-extension rungs (`lambda_shards`).

Phase 1 of `specs/avail-v3-lambda-cascade.md`: build the per-tier rungs
ABOVE the CFW's `shards` ladder (N ≤ 4096 vs the CFW's N ≤ 960), from
each tier's own existing cover.

Extension shards are same-tier consolidations with matching bins, so no
re-aggregation is needed: read the sub-rung cover tiles (disjoint,
aligned), concat, sort `(s2_cell, dt)`, write. Peak memory is one
output table (~100-200 B/row in Arrow → ≤ ~3 GB at N=4096), NOT the
`materialize_shard` long-frame explode (~17 GB at N=1440) — that's what
makes these buildable in a 10 GB Lambda.

Runs identically on a laptop (`ctbk gbfs lambda fill`) and in the AWS
Lambda handler (`gbfs/lambda/handler.py`).
"""
from __future__ import annotations

import io
import time as _time
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import yaml as _yaml
from pyrmts import ExpectedShard, parse_pyramid_yaml, pyramid_from_config
from pyrmts.types import Tier
from utz import err

from .config import parse_rg_sizes, rg_size_for
from .lite import AVAIL_GENESIS, R2_BUCKET, MaterializeResult, dur_min


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
    """Return YAML text with each tier's `shards` extended by its
    `lambda_shards` — the Lambda executor's view of the ladder. Enforces
    that each extension continues the tier's divisibility chain."""
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


def _shard_key(pyramid, tier: str, shard_dur: str, period_start: datetime) -> str:
    """Substitute the pyramid's keyTemplate for a specific shard."""
    from pyrmts.axis import format_period, parse_duration
    from pyrmts.keys import substitute_key
    label = format_period(period_start, parse_duration(shard_dur))
    return substitute_key(
        pyramid.keyTemplate,
        {'tier': tier, 'shard': shard_dur, 'period': label},
    )


def _tile_from_existing(
    pyramid,
    tier: Tier,
    gap: ExpectedShard,
    key_set: set[str],
) -> tuple[list[tuple[str, str]], list[tuple[datetime, datetime]]]:
    """Greedy largest-first tiling of the gap period from EXISTING
    same-tier shards (`key_set` — the discovery-time R2 listing, kept
    fresh by the fill loop). The prescriptive expected cover is wrong
    here: it demands largest-fitting sub-rungs (e.g. `1d` tiles) that no
    min-cover ever materialized; what's actually on R2 is whatever mix
    of rungs history produced (12h tiles, relics, dust). Same principle
    as the CFW's `planDustTiling`.

    Returns `([(rung, key)...] in period order, [uncovered holes])`.
    Pre-genesis segments are dropped (no data ever existed)."""
    from datetime import timedelta
    rungs = [r for r in tier.shards if dur_min(r) < dur_min(gap.shard_dur)]
    picks: list[tuple[str, str]] = []
    holes: list[tuple[datetime, datetime]] = []

    def tile(seg_start: datetime, seg_end: datetime, idx: int) -> None:
        if seg_end <= AVAIL_GENESIS:
            return
        if idx < 0:
            holes.append((seg_start, seg_end))
            return
        rung = rungs[idx]
        dur = timedelta(minutes=dur_min(rung))
        # Epoch-aligned slots of `rung` within [seg_start, seg_end).
        # Divisibility chaining ⇒ seg boundaries align to some rung ≤
        # the current one; misaligned leading/trailing parts descend.
        epoch_off = (seg_start - datetime(1970, 1, 1, tzinfo=timezone.utc)) % dur
        first_slot = seg_start + ((dur - epoch_off) % dur)
        cur = seg_start
        slot = first_slot
        while slot + dur <= seg_end:
            if cur < slot:
                tile(cur, slot, idx - 1)
            key = _shard_key(pyramid, tier.name, rung, slot)
            if key in key_set:
                picks.append((rung, key))
            else:
                tile(slot, slot + dur, idx - 1)
            cur = slot + dur
            slot = cur
        if cur < seg_end:
            tile(cur, seg_end, idx - 1)

    tile(gap.period_start, gap.period_end, len(rungs) - 1)
    return picks, holes


RAW_MINUTE_PREFIX = 'gbfs/avail/agg=1m/cons=1m'
STATION_LUC_KEY = 'station-luc.json'
COARSEST_LEVEL = 10
# Past this age a missing raw WAL minute was a missed poll and will
# never arrive; ship without it (same policy as the CFW cascade).
RAW_FINALITY_S = 15 * 60

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
    Missing minutes past `RAW_FINALITY_S` are skipped (missed polls);
    a RECENT missing minute returns None (retry once the poller lands
    it). Mirrors the CFW's `readRawRows` + finality policy."""
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
            if (now - cur).total_seconds() < RAW_FINALITY_S:
                return None  # poller may still land it — retry next run
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


def _source_tier_for(pyramid, tier_name: str) -> Tier | None:
    """Strict-cascade source tier: the coarsest tier T' with
    `bin(T') < bin(tier)` and `bin(tier) % bin(T') == 0` (divisibility
    keeps floor-then-merge exact). `None` for the finest tier."""
    target = dur_min(next(t for t in pyramid.tiers if t.name == tier_name).bin)
    best = None
    for t in pyramid.tiers:
        b = dur_min(t.bin)
        if b < target and target % b == 0 and (best is None or b > dur_min(best.bin)):
            best = t
    return best


def _overlap_cover(
    pyramid,
    src: Tier,
    s: datetime,
    e: datetime,
    key_set: set[str],
) -> tuple[list[tuple[str, datetime, datetime]], list[tuple[datetime, datetime]]]:
    """Cover [s, e) with EXISTING source-tier tiles of any rung —
    including tiles that only PARTIALLY overlap the interval (the
    reader clips each tile to its assigned subinterval). Nested-slot
    tiling misses these: a source min-cover tile (/15m@3h
    [18:00, 21:00)) can cover the head of a /30m@2h hole
    [20:00, 22:00) while no /15m@1h tile at 20:00 ever exists — the
    2026-07-13 evening wedge, where two such holes bounced `no_inputs`
    for 2.5 h and dammed every coarser tier until the midnight
    boundary reshuffled the rung layout.

    Greedy coarsest-first; assigned subintervals are disjoint by
    construction (each pick advances only through still-uncovered
    range), so per-pick clipping can't double-count rows. Returns
    `([(key, clip_start, clip_end)…], [uncovered holes])`."""
    from datetime import timedelta
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    uncovered = [(s, e)]
    picks: list[tuple[str, datetime, datetime]] = []
    for rung in reversed(src.shards):
        dur = timedelta(minutes=dur_min(rung))
        remaining: list[tuple[datetime, datetime]] = []
        for a, b in uncovered:
            cur = a
            slot = a - ((a - epoch) % dur)
            while slot < b:
                if _shard_key(pyramid, src.name, rung, slot) in key_set:
                    if cur < slot:
                        remaining.append((cur, slot))
                    lo, hi = max(cur, slot), min(b, slot + dur)
                    if lo < hi:
                        picks.append((_shard_key(pyramid, src.name, rung, slot), lo, hi))
                    cur = max(cur, hi)
                slot += dur
            if cur < b:
                remaining.append((cur, b))
        uncovered = remaining
        if not uncovered:
            break
    return picks, uncovered


def _fill_hole_cross_tier(
    r2,
    pyramid,
    tier: Tier,
    hole: tuple[datetime, datetime],
    key_set: set[str],
) -> pa.Table | None:
    """Rebin the finer source tier over `hole` up to `tier`'s bin:
    floor dt, merge histogram JSONs per (cell, dt, metric) — the CFW's
    `kwayMerge` hole-fill, in pure python (holes are small: the scars
    are hours-to-a-day). Sources may be tiles merely OVERLAPPING the
    hole (each is clipped to its assigned subinterval on read).
    Returns None if the source tier can't cover the hole either."""
    import json as _json
    src = _source_tier_for(pyramid, tier.name)
    if src is None:
        return None
    s, e = hole
    entries, uncovered = _overlap_cover(pyramid, src, s, e, key_set)
    if uncovered:
        return None
    # One R2 read per distinct key, applied over that key's (disjoint)
    # assigned clip ranges.
    by_key: dict[str, list[tuple[int, int]]] = {}
    for k, cs, ce in entries:
        by_key.setdefault(k, []).append(
            (int(cs.timestamp() * 1000), int(ce.timestamp() * 1000)))

    bin_ms = dur_min(tier.bin) * 60_000
    metrics = [m.name for m in pyramid.metrics]
    acc: dict[tuple[str, int], list[dict[str, int]]] = {}
    import pyarrow.compute as pc
    for k, ranges in by_key.items():
        obj = r2.get_object(Bucket=R2_BUCKET, Key=k)
        body = obj['Body'].read()
        # Stream row-group batches and arrow-filter to the clip ranges:
        # a whole-file `to_pylist` of a max-rung source (e.g. /1m@2d,
        # ~12 M rows × 7 cols ≈ 5-7 GB of python objects) GC-thrashed
        # the 10 GB Lambda into its 900 s timeout during the first
        # scaffolded rebuild. Python-side work is now proportional to
        # the CLIPPED rows, not the source file.
        pf = pq.ParquetFile(io.BytesIO(body))
        for batch in pf.iter_batches(columns=['s2_cell', 'dt', *metrics]):
            dt_arr = batch.column(batch.schema.get_field_index('dt'))
            mask = None
            for lo, hi in ranges:
                m = pc.and_(pc.greater_equal(dt_arr, lo), pc.less(dt_arr, hi))
                mask = m if mask is None else pc.or_(mask, m)
            if not pc.any(mask).as_py():
                continue
            cols = batch.filter(mask).to_pydict()
            for i, dt in enumerate(cols['dt']):
                dt = int(dt)
                key2 = (cols['s2_cell'][i], dt - dt % bin_ms)
                hists = acc.get(key2)
                if hists is None:
                    hists = acc[key2] = [{} for _ in metrics]
                for mi, m in enumerate(metrics):
                    for state, n in _json.loads(cols[m][i]).items():
                        h = hists[mi]
                        h[state] = h.get(state, 0) + n
            del cols
        del pf, body
    if not acc:
        # Cover was complete (no `uncovered` return above) but the clip
        # matched zero source rows: a genuine data outage window (e.g.
        # the 2026-05-03 scraper gap — hour 00 has no raw minutes at
        # all). "No data" is a valid, final answer — same policy as
        # `_fill_hole_raw`'s all-missed-past-finality case. Returning
        # None here instead bounced every rung containing such a scar
        # as `no_inputs`, permanently unfillable.
        return pa.table({
            's2_cell': pa.array([], pa.string()), 'dt': pa.array([], pa.int64()),
            **{m: pa.array([], pa.string()) for m in metrics},
        })
    cells, dts = zip(*acc.keys())
    def dump(h: dict[str, int]) -> str:
        return _json.dumps({k: h[k] for k in sorted(h, key=int)}, separators=(',', ':'))
    arrays: dict[str, pa.Array] = {
        's2_cell': pa.array(cells, pa.string()),
        'dt': pa.array(dts, pa.int64()),
    }
    for mi, m in enumerate(metrics):
        arrays[m] = pa.array([dump(v[mi]) for v in acc.values()], pa.string())
    return pa.table(arrays)


def materialize_extension_shard(
    r2,
    pyramid,
    gap: ExpectedShard,
    *,
    key_set: set[str],
    rg_size: int = 2048,
    head_check: bool = True,
) -> MaterializeResult:
    """Same-tier concat build of one extension shard. Idempotent
    (`key_set`/HEAD skip). Source = the tier's sub-rung cover of the
    gap period; cover tiles entirely pre-genesis are skipped (no data
    ever existed); any other missing tile → `no_inputs` (retry next
    invocation once the CFW/fill-order lands it).

    `head_check=False` for stale-content rebuilds: the key EXISTS on R2
    (with a pre-`stale_before` mtime, excluded from `key_set`) and must
    be overwritten in place — the HEAD probe would wrongly 'exists'-skip
    it. `key_set` membership (fresh keys only) still short-circuits, so
    a re-run skips shards already rebuilt."""
    tag = f"/{gap.tier}@{gap.shard_dur} {gap.period_start.date()}"
    t0 = _time.time()
    if gap.key in key_set:
        return MaterializeResult(gap=gap, status='exists')
    if head_check:
        try:
            r2.head_object(Bucket=R2_BUCKET, Key=gap.key)
            key_set.add(gap.key)
            return MaterializeResult(gap=gap, status='exists')
        except r2.exceptions.ClientError:
            pass
    if gap.period_end <= AVAIL_GENESIS:
        return MaterializeResult(gap=gap, status='no_inputs', inputs_present=0,
                                 inputs_expected=0, source_desc='pre-genesis')

    tier = next(t for t in pyramid.tiers if t.name == gap.tier)
    finest = min(pyramid.tiers, key=lambda t: dur_min(t.bin))
    picks, holes = _tile_from_existing(pyramid, tier, gap, key_set)
    hole_tables: list[pa.Table] = []
    for hole in holes:
        # Holes are either scars (dust that never materialized) or —
        # for a tier's smallest rung, which has no sub-rungs — the
        # whole period. The finest tier fills from the raw WAL; others
        # rebin their divisible source tier.
        if tier.name == finest.name:
            ht = _fill_hole_raw(r2, pyramid, hole, datetime.now(timezone.utc))
        else:
            ht = _fill_hole_cross_tier(r2, pyramid, tier, hole, key_set)
        if ht is None:
            err(f"  ⟶ {tag} → no_inputs (hole "
                f"[{hole[0].isoformat()}, {hole[1].isoformat()}) unfillable)")
            return MaterializeResult(
                gap=gap, status='no_inputs',
                inputs_present=len(picks), inputs_expected=len(picks) + len(holes),
                source_desc='same-tier tiling + cross-tier hole-fill',
            )
        hole_tables.append(ht)
    inputs_expected = len(picks) + len(holes)
    if not picks and not hole_tables:
        return MaterializeResult(gap=gap, status='empty', source_desc='no data in period')

    err(f"  ⟶ {tag} → reading {len(picks)} existing tiles"
        + (f" + {len(holes)} cross-tier holes" if holes else ""))
    tables: list[pa.Table] = list(hole_tables)
    for _rung, k in picks:
        obj = r2.get_object(Bucket=R2_BUCKET, Key=k)
        t = pq.read_table(io.BytesIO(obj['Body'].read()))
        # Cover tiles span writer eras (pyarrow / hyparquet-writer / CFW
        # restat) whose schemas differ in string vs large_string; cast to
        # the canonical narrow-string schema so concat doesn't throw.
        t = t.cast(pa.schema([
            (f.name, pa.string() if pa.types.is_large_string(f.type) else f.type)
            for f in t.schema
        ]))
        tables.append(t)
    combined = pa.concat_tables(tables)
    del tables
    if combined.num_rows == 0:
        return MaterializeResult(gap=gap, status='empty',
                                 inputs_present=inputs_expected,
                                 inputs_expected=inputs_expected,
                                 source_desc='same-tier cover')
    # Cover tiles are disjoint + fit inside the gap period, so no dt
    # clipping — just the (s2_cell, dt) sort for RG-prunable layout.
    combined = combined.sort_by([('s2_cell', 'ascending'), ('dt', 'ascending')])
    buf = io.BytesIO()
    pq.write_table(combined, buf, row_group_size=rg_size, compression='snappy')
    blob = buf.getvalue()
    r2.put_object(Bucket=R2_BUCKET, Key=gap.key, Body=blob)
    key_set.add(gap.key)
    err(f"  ⟵ {tag} → wrote ({combined.num_rows:,} rows, {len(blob)/1e6:.1f}MB, "
        f"{_time.time()-t0:.1f}s)")
    return MaterializeResult(
        gap=gap, status='wrote', bytes_written=len(blob), rows=combined.num_rows,
        inputs_present=inputs_expected, inputs_expected=inputs_expected,
        source_desc=f'same-tier cover ×{inputs_expected}',
    )


def _reconcile_registrations(
    expected_by_tier: dict,
    existing: set[str],
    pyramid_name: str,
    now: datetime,
) -> None:
    """Re-register expected shards that exist on storage but are absent
    from D1. A write-then-die (e.g. the 15-min timeout landing between an
    R2 put and its registration) strands an unregistered object forever:
    storage-based discovery sees the key and never re-fills, while
    D1-gated serving never sees the shard. One SELECT per tick closes
    that window. Best-effort: a D1 outage must not block the fill."""
    from .d1_http import d1_query, register_shard
    try:
        rows = d1_query(
            'SELECT key FROM pyramid_shards WHERE pyramid = ?', [pyramid_name])
        registered = {r['key'] for r in rows}
    except Exception as e:
        err(f'  reconcile: D1 read failed ({e}); skipping this tick')
        return
    stranded = [
        e for shards in expected_by_tier.values() for e in shards
        if e.key in existing and e.key not in registered
    ]
    for e in stranded:
        register_shard(
            pyramid=pyramid_name,
            tier=e.tier,
            shard_dur=e.shard_dur,
            period_start_ms=int(e.period_start.timestamp() * 1000),
            period_end_ms=int(e.period_end.timestamp() * 1000),
            key=e.key,
            written_at_ms=int(now.timestamp() * 1000),
        )
    if stranded:
        err(f'  reconcile: re-registered {len(stranded)} present-but-unregistered shards')
        # TEMP diagnostic (2026-07-28): rows re-registered every tick keep
        # vanishing — read one back in the same invocation to split
        # "write never lands" from "deleted between ticks".
        probe = stranded[0].key
        back = d1_query(
            'SELECT key, written_at FROM pyramid_shards WHERE pyramid = ? AND key = ?',
            [pyramid_name, probe])
        err(f'  reconcile: read-back {probe}: {back or "MISSING IMMEDIATELY"}')


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
    """Discover + fill missing extension-rung shards over
    [genesis, now). With `register`, each `wrote` is INSERT-OR-REPLACEd
    into `pyramid_shards` via the D1 REST API immediately after its R2
    put (per-shard, so a mid-run abort can't strand unregistered keys
    beyond the one in flight).

    `stale_before`: shards last-modified before this UTC timestamp are
    treated as missing and rebuilt in place (content invalidation, e.g.
    a station-luc re-key — see `specs/avail-v3-lambda-rebuild.md`). The
    steady-state EventBridge tick never sets it."""
    from .fsck import discover_gaps
    from .lite import r2_client

    now = now or datetime.now(timezone.utc)
    set_chains_mode(parse_chains_mode(config_yaml))
    ext_by_tier = parse_lambda_shards(config_yaml)
    if not ext_by_tier:
        raise ValueError('config declares no lambda_shards')
    merged_yaml = merge_lambda_shards(config_yaml)
    cfg = parse_pyramid_yaml(merged_yaml)
    from .storage import storage_from_cfg
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    rg_sizes = parse_rg_sizes(config_yaml)

    gaps, existing, _expected = discover_gaps(
        pyramid, (AVAIL_GENESIS, now), stale_before=stale_before)
    if register and not dry_run:
        _reconcile_registrations(_expected, existing, pyramid_name, now)
    # Any gap with same-tier sub-rungs to build from is ours — extension
    # rungs by design, but also in-ladder rungs the CFW couldn't produce
    # (e.g. `too_large` bounces: /3m@2d's ragged 95 MB plan). Gaps at a
    # tier's smallest rung need raw/cross-tier ingest — those stay with
    # the CFW (it self-heals them within its budgets).
    # `fill_all` (P2 cutover): also handle each tier's smallest rung
    # (raw ingest at the finest tier, cross-tier rebin elsewhere) — the
    # rungs the CFW cascade owns until it's retired.
    smallest = {t.name: t.shards[0] for t in pyramid.tiers}
    ext_gaps = [
        g for g in gaps
        if (fill_all or g.shard_dur != smallest[g.tier])
        # Trailing max-shards whose notional period ends pre-genesis can
        # never exist — permanent no-ops, excluded from the census.
        and g.period_end > AVAIL_GENESIS
    ]
    err(f"fillable gaps: {len(ext_gaps)} of {len(gaps)} total missing")
    if dry_run:
        for g in ext_gaps[:40]:
            err(f"  would fill /{g.tier}@{g.shard_dur} {g.period_start.date()}")
        return []

    r2 = r2_client()
    if stale_before is not None:
        # A warm container's cached station-luc chains may predate the
        # re-key that made these shards stale; refresh before any raw
        # hole-fill expands stations through old anchors.
        _chains(r2, fetched_after=stale_before)
    t0 = _time.time()
    results: list[MaterializeResult] = []
    for g in ext_gaps:
        if fill_limit is not None and len(results) >= fill_limit:
            err(f"  hit fill limit {fill_limit}; stopping")
            break
        if time_budget_s is not None and _time.time() - t0 > time_budget_s:
            err(f"  hit time budget {time_budget_s:.0f}s; stopping")
            break
        res = materialize_extension_shard(
            r2, pyramid, g, key_set=existing, rg_size=rg_size_for(rg_sizes, g.tier),
            head_check=stale_before is None)
        results.append(res)
        if res.status == 'wrote' and register:
            from .d1_http import register_shard
            register_shard(
                pyramid=pyramid_name, tier=g.tier, shard_dur=g.shard_dur,
                period_start_ms=int(g.period_start.timestamp() * 1000),
                period_end_ms=int(g.period_end.timestamp() * 1000),
                key=g.key,
                written_at_ms=int(_time.time() * 1000),
            )
    by_status: dict[str, int] = {}
    for r in results:
        by_status[r.status] = by_status.get(r.status, 0) + 1
    err(f"extension fill: {by_status or 'nothing to do'}")
    return results


# ─── Single-gap invocations (specs/avail-v3-lambda-rebuild.md) ─────────
#
# The fan-out rebuild driver (`ctbk gbfs lambda rebuild`) discovers gaps
# locally and invokes the Lambda once per gap; the event carries the full
# `ExpectedShard` (all durations in the avail ladder are fixed — no
# calendar units — so the driver-side key/period computation is
# authoritative and the handler doesn't re-derive it).


def encode_gap(gap: ExpectedShard) -> dict:
    """`ExpectedShard` → JSON-serializable event payload."""
    return {
        'tier': gap.tier,
        'shard_dur': gap.shard_dur,
        'period_start': gap.period_start.isoformat(),
        'period_end': gap.period_end.isoformat(),
        'key': gap.key,
    }


def decode_gap(d: dict) -> ExpectedShard:
    """Event payload → `ExpectedShard` (inverse of `encode_gap`).

    The wire format predates (and deliberately omits) the effective
    bounds — they're reconstructed as the genesis-clipped period, which
    is what the materializers assumed before `ExpectedShard` grew the
    fields (trailing-edge clipping is handled by the fill paths'
    own head checks, not by `effective_end`)."""
    period_start = datetime.fromisoformat(d['period_start'])
    period_end = datetime.fromisoformat(d['period_end'])
    return ExpectedShard(
        tier=d['tier'],
        shard_dur=d['shard_dur'],
        period_start=period_start,
        period_end=period_end,
        effective_start=max(period_start, AVAIL_GENESIS),
        effective_end=period_end,
        key=d['key'],
    )


def run_single_gap(
    config_yaml: str,
    gap: ExpectedShard,
    *,
    stale_before: datetime | None = None,
    register: bool = True,
    pyramid_name: str = 'avail',
) -> MaterializeResult:
    """Materialize ONE shard (no discovery loop) — the handler branch a
    fan-out driver invokes concurrently. Lists existing keys (a few LIST
    pages) so same-tier tiling / cross-tier covers see the current R2
    state; with `stale_before`, pre-re-key keys are excluded from that
    view (stale sub-tiles are never concat'd into a rebuilt shard) and
    the target key is overwritten in place."""
    from .fsck import list_existing_with_mtime, split_stale
    from .lite import r2_client
    from .storage import storage_from_cfg

    set_chains_mode(parse_chains_mode(config_yaml))
    merged_yaml = merge_lambda_shards(config_yaml)
    cfg = parse_pyramid_yaml(merged_yaml)
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    rg_sizes = parse_rg_sizes(config_yaml)

    r2 = r2_client()
    if stale_before is not None:
        _chains(r2, fetched_after=stale_before)
    existing_mtimes = list_existing_with_mtime(pyramid, pyramid.storage)
    fresh, stale = split_stale(existing_mtimes, stale_before)
    err(f"single-gap /{gap.tier}@{gap.shard_dur} {gap.period_start.date()}: "
        f"{len(fresh)} fresh keys" + (f", {len(stale)} stale" if stale else ""))
    res = materialize_extension_shard(
        r2, pyramid, gap,
        key_set=fresh,
        rg_size=rg_size_for(rg_sizes, gap.tier),
        head_check=stale_before is None,
    )
    if res.status == 'wrote' and register:
        from .d1_http import register_shard
        register_shard(
            pyramid=pyramid_name, tier=gap.tier, shard_dur=gap.shard_dur,
            period_start_ms=int(gap.period_start.timestamp() * 1000),
            period_end_ms=int(gap.period_end.timestamp() * 1000),
            key=gap.key,
            written_at_ms=int(_time.time() * 1000),
        )
    return res
