"""Per-tier config extras — now first-class in pyrmts (`Tier.rg_size`,
ops-adoption phase 1); this module keeps the dict-shaped view ctbk call
sites consume and the built-in 2048 default (ctbk policy — pyrmts
leaves unset tiers as `None` = writer heuristic).

The former `base:`-block handling was dropped: no ctbk config declares
one (pyrmts models tiers only).
"""
from __future__ import annotations


DEFAULT_RG_SIZE = 2048


def parse_rg_sizes(yaml_text: str) -> dict[str, int]:
    """`{tier_name: rg_size}` for every declared tier, resolved
    tier-`rg_size:` > `defaults.rg_size` (both via pyrmts) >
    `DEFAULT_RG_SIZE`."""
    from pyrmts import parse_pyramid_yaml
    cfg = parse_pyramid_yaml(yaml_text)
    return {
        t.name: (t.rg_size if t.rg_size is not None else DEFAULT_RG_SIZE)
        for t in cfg.tiers
    }


def rg_size_for(rg_sizes: dict[str, int] | None, tier_name: str) -> int:
    """Look up a tier's RG size; falls back to `DEFAULT_RG_SIZE`."""
    if rg_sizes is None:
        return DEFAULT_RG_SIZE
    return rg_sizes.get(tier_name, DEFAULT_RG_SIZE)
