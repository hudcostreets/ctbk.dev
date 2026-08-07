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


def _rides(pyramid, filter, anchor: str):
    """`specs/rides-v5.md`: monthly normalized parquets (PUBLIC AWS S3
    `ctbk` bucket — not the R2 bucket the pyramid writes) → every rung.
    Chains = frozen vocab + `s:<short_name>` (as `avail_daily_status`),
    keyed by canonical short_name; the id-map + geo fallback assets are
    baked into the image."""
    import json
    from pathlib import Path

    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config as BotoConfig

    from ctbk_rides_source import MonthlyRidesSource
    from ctbk_vocab import load_vocab, station_chain

    if filter:
        raise ValueError(f'rides source: no filter dims supported, got {filter!r}')
    here = Path(__file__).parent
    vocab = load_vocab(here / 'station-vocab.json')
    luc = json.loads(pyramid.storage.get('station-luc.json'))
    chains = {
        short_name: station_chain(e['lat'], e['lng'], short_name, vocab)
        for short_name, e in luc['by_short_name'].items()
    }
    idm = json.loads((here / 'station-id-map.json').read_text())
    merged = luc.get('merged', {})
    canonical = {sid: merged.get(canon, canon) for sid, canon in idm.items()}
    geo = {
        sid: (lat, lng)
        for sid, (lat, lng) in json.loads((here / 'station-geo.json').read_text()).items()
    }

    s3 = boto3.client('s3', region_name='us-east-1', config=BotoConfig(signature_version=UNSIGNED))
    paginator = s3.get_paginator('list_objects_v2')
    available = set()
    for page in paginator.paginate(Bucket='ctbk', Prefix='normalized/'):
        for o in page.get('Contents', []):
            name = o['Key'].removeprefix('normalized/')
            if len(name) == 14 and name.endswith('.parquet') and name[:6].isdigit():
                available.add(name[:6])

    def fetch_s3(key: str) -> bytes | None:
        try:
            return s3.get_object(Bucket='ctbk', Key=key)['Body'].read()
        except s3.exceptions.NoSuchKey:
            return None

    return MonthlyRidesSource(
        pyramid, anchor,
        chains=chains, canonical=canonical, geo=geo,
        vocab_cells=frozenset(vocab),
        available_months=available,
        fetch_fn=fetch_s3,
    )


def rides_start(pyramid, filter):
    return _rides(pyramid, filter, 'start')


def rides_end(pyramid, filter):
    return _rides(pyramid, filter, 'end')
