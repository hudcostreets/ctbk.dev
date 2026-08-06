"""Source factories for `pyrmts-engine build -x` (Batch derived image).

The base-image default is `WideShardSource` on `tier.shards[0]` — the
smallest rung, which the GC sweep doesn't retain. ctbk's durable base
rung is `/1m@2d` (the Lambda-cascade max rung), so builds must pin it
explicitly.
"""
from pyrmts_engine import WideShardSource


def avail_1m_2d(pyramid, filter):
    return WideShardSource(pyramid, tier_name='1m', shard_dur='2d', filter=filter)


def avail_daily_status(pyramid, filter):
    """Raw-ingest source for the avail-v6 LU-attributed regen (pyrmts
    `specs/engine-raw-ingest.md`): daily status parquets → every rung
    including `/1m`. Chains = frozen ragged vocabulary (bundled
    `station-vocab.json`) + `s:<short_name>` identity keys, expanded
    from the station registry (`station-luc.json`, read through the
    pyramid's storage — only its stable identity fields; mirrors
    `lambda_exec._vocab_chains`)."""
    import json
    from pathlib import Path
    from ctbk_raw_source import DailyStatusSource
    from ctbk_vocab import load_vocab, station_chain
    if filter:
        raise ValueError(f'avail_daily_status: no filter dims supported, got {filter!r}')
    vocab = load_vocab(Path(__file__).parent / 'station-vocab.json')
    data = json.loads(pyramid.storage.get('station-luc.json'))
    chains = {}
    for uuid, short_name in data['by_uuid'].items():
        e = data['by_short_name'].get(short_name)
        if not e:
            continue
        chains[uuid] = station_chain(e['lat'], e['lng'], short_name, vocab)
    return DailyStatusSource(pyramid, chains)
