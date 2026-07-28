"""ctbk pyramid-cascade: GBFS-specific seams around the pyrmts pyramid
stack (ops-adoption: pyrmts `specs/pyrmts-ops-adoption.md`).

What lives here: the raw-WAL hole fill + station-chain machinery
(`lambda_exec`), proxy-aware D1 registry access (`d1_http`), the merged
ladder / genesis / cost-model constants, and thin wrappers over
`pyrmts_engine.{discovery,consolidate,validate}` + `pyrmts_ops`
(`fsck`, `gc`, `rebuild`, `engine_check`). The block/streaming build
engines that once lived here were deleted — bulk builds run on Batch
via `pyrmts_engine.build_local` (`ctbk gbfs engine submit`).
"""
from __future__ import annotations
