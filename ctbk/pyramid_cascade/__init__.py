"""ctbk pyramid-cascade: linear-scaling cascading-pyramid build tool.

See `specs/pyramid-cascade.md`.

Engine (per-block):
  cascade_block(pyramid, block_range, ingester, staging) → ShardWriteSet

Orchestrator:
  pyramid_cascade(pyramid, range, ingester, workers, task_size, staging)
    1. Split range into blocks aligned at task_size
    2. ProcessPool: cascade_block per block; outputs to final R2 path if
       fully-owned, else to staging
    3. Reduce: for each (tier, period) with multiple block-partials, concat
       + groupby+histogram-sum, write final, delete partials
    4. Emit manifest at <root>/_manifest.json

Top-level re-exports resolve lazily (PEP 562): the engine/orchestrator
pull polars, which the AWS Lambda bundle (see `gbfs/lambda/`)
deliberately omits — the Lambda imports only the polars-free
`lambda_exec`/`lite`/`fsck` modules and must not pay for these at
package-import time.
"""
from __future__ import annotations

__all__ = ['cascade_block', 'ShardWriteSet', 'pyramid_cascade', 'CascadeRunResult']


def __getattr__(name: str):
    if name in ('cascade_block', 'ShardWriteSet'):
        from . import engine
        return getattr(engine, name)
    if name in ('pyramid_cascade', 'CascadeRunResult'):
        from . import orchestrator
        return getattr(orchestrator, name)
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
