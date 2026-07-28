"""Storage factory — thin wrapper over `pyrmts.storage.storage_from_cfg`
(moved upstream, ops-adoption phase 1: pyrmts `specs/pyrmts-ops-adoption.md`).

`profile='cf'` preserves ctbk's must-have-R2-creds behavior: the generic
factory only *raises* on unresolvable creds when a profile is requested
(its bare-`S3Storage` fallthrough would otherwise let the default AWS
chain pick a 20-char AWS key for an R2 endpoint — the trap the original
module here existed to avoid).
"""
from __future__ import annotations

from pyrmts.storage import S3Storage, storage_from_cfg as _storage_from_cfg


def storage_from_cfg(storage_cfg: dict) -> S3Storage:
    return _storage_from_cfg(storage_cfg, profile='cf')
