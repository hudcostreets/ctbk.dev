"""Auxiliary config parsing — picks per-tier extras out of the YAML that
pyrmts's `parse_pyramid_yaml` doesn't preserve.

For now: per-tier row-group size (`rg_size`), with an optional
`defaults.rg_size` and a per-tier override. Future: per-tier compression
codec, sort overrides, etc.
"""
from __future__ import annotations

from typing import Any

import yaml as _yaml


DEFAULT_RG_SIZE = 2048


def parse_rg_sizes(yaml_text: str) -> dict[str, int]:
    """Return `{tier_name: rg_size}` for every tier declared in the YAML.

    Resolution order per tier:
      1. The tier's own `rg_size:` field (if set).
      2. `defaults.rg_size` (if set).
      3. The built-in `DEFAULT_RG_SIZE` (2048).

    The `base:` block (when present) is treated as a tier too, so its
    `rg_size` participates.
    """
    raw: Any = _yaml.safe_load(yaml_text)
    if not isinstance(raw, dict):
        return {}
    default_rg = int((raw.get('defaults') or {}).get('rg_size', DEFAULT_RG_SIZE))

    out: dict[str, int] = {}

    base = raw.get('base') or {}
    if isinstance(base, dict):
        name = base.get('name') or base.get('tier')
        if isinstance(name, str):
            out[name] = int(base.get('rg_size', default_rg))

    for tier_cfg in raw.get('tiers') or []:
        if not isinstance(tier_cfg, dict):
            continue
        name = tier_cfg.get('name')
        if not isinstance(name, str):
            continue
        out[name] = int(tier_cfg.get('rg_size', default_rg))

    return out


def rg_size_for(rg_sizes: dict[str, int] | None, tier_name: str) -> int:
    """Look up a tier's RG size; falls back to `DEFAULT_RG_SIZE`."""
    if rg_sizes is None:
        return DEFAULT_RG_SIZE
    return rg_sizes.get(tier_name, DEFAULT_RG_SIZE)
