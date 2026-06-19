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
"""
from __future__ import annotations

from .engine import ShardWriteSet, cascade_block
from .orchestrator import CascadeRunResult, pyramid_cascade

__all__ = ['cascade_block', 'ShardWriteSet', 'pyramid_cascade', 'CascadeRunResult']
