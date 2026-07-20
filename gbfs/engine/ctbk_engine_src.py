"""Source factories for `pyrmts-engine build -x` (Batch derived image).

The base-image default is `WideShardSource` on `tier.shards[0]` — the
smallest rung, which the GC sweep doesn't retain. ctbk's durable base
rung is `/1m@2d` (the Lambda-cascade max rung), so builds must pin it
explicitly.
"""
from pyrmts_engine import WideShardSource


def avail_1m_2d(pyramid, filter):
    return WideShardSource(pyramid, tier_name='1m', shard_dur='2d', filter=filter)
