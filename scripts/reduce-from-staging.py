#!/usr/bin/env python3
"""Resume the reduce phase of a `ctbk pyramid-cascade` run from a
file-system staging directory.

Useful when the block phase completed but the reduce phase died (e.g.
OOM). Walks `<STAGING>/_tmp/<block_id>/<tier>/<period>.parquet`, groups
the partials by `(tier, period)`, and dispatches the same `_reduce_task`
worker that `pyramid_cascade()` uses for its parallel reduce.

Usage:
  reduce-from-staging.py \\
    -c configs/pyramids/avail.yaml \\
    -s /tmp/pyramid-cascade-1781998317/ \\
    [-j 4] [--skip-existing]
"""
from __future__ import annotations

import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import defaultdict
from pathlib import Path

from click import command, option, Path as ClickPath
from pyrmts import parse_pyramid_yaml, pyramid_from_config
from utz import err

from ctbk.pyramid_cascade.orchestrator import _reduce_task
from ctbk.pyramid_cascade.storage import storage_from_cfg
from ctbk.pyramid_cascade.config import parse_rg_sizes


@command(help="Resume reduce phase from a pyramid-cascade FS staging directory.")
@option('-c', '--config', 'config_path', required=True, type=ClickPath(exists=True, dir_okay=False), help='Path to the pyramid YAML config (must match the run that produced the staging dir).')
@option('-j', '--workers', type=int, default=4, show_default=True, help='ProcessPool size for the reduce phase.')
@option('-S', '--skip-existing', is_flag=True, help='Skip (tier, period) groups whose final shard already exists on R2.')
@option('-s', '--staging-dir', required=True, type=ClickPath(exists=True, file_okay=False), help='Root of the FS staging dir (contains `_tmp/<block_id>/...`).')
def main(config_path: str, workers: int, skip_existing: bool, staging_dir: str):
    config_yaml = Path(config_path).read_text()
    cfg = parse_pyramid_yaml(config_yaml)
    storage = storage_from_cfg(cfg.storage)
    pyramid = pyramid_from_config(cfg, storage)
    rg_sizes = parse_rg_sizes(config_yaml)

    staging_uri = f"file://{Path(staging_dir).resolve()}"
    staging_root = Path(staging_dir) / '_tmp'
    err(f"reduce-from-staging:")
    err(f"  config:     {config_path}")
    err(f"  staging:    {staging_uri}")
    err(f"  workers:    {workers}")

    # Walk partials. Layout: _tmp/<block_id>/<tier>/<period>.parquet
    by_key: dict[tuple[str, str], list[str]] = defaultdict(list)
    n_files = 0
    for block_dir in sorted(staging_root.iterdir()):
        if not block_dir.is_dir():
            continue
        for tier_dir in sorted(block_dir.iterdir()):
            if not tier_dir.is_dir():
                continue
            tier = tier_dir.name
            for shard_file in sorted(tier_dir.iterdir()):
                if not shard_file.is_file() or shard_file.suffix != '.parquet':
                    continue
                period = shard_file.stem
                # The staging Key is relative to the staging root passed to FsStorage,
                # which is the parent of _tmp/ (matches the orchestrator's
                # `_tmp/<block_id>/{tier}/{period}.parquet` key template).
                rel = shard_file.relative_to(Path(staging_dir))
                by_key[(tier, period)].append(str(rel))
                n_files += 1

    err(f"  found:      {n_files} partials → {len(by_key)} (tier, period) groups")

    if skip_existing:
        from pyrmts import substitute_key
        before = len(by_key)
        filtered = {}
        for (tier_name, period_label), keys in by_key.items():
            final_key = substitute_key(
                pyramid.keyTemplate,
                {'tier': tier_name, 'period': period_label},
            )
            if storage.head(final_key) is None:
                filtered[(tier_name, period_label)] = keys
        by_key = filtered
        err(f"  skipped:    {before - len(by_key)} groups whose finals already exist on R2")

    if not by_key:
        err("nothing to do")
        return

    t0 = time.time()
    done = 0
    finals = bytes_written = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(_reduce_task, config_yaml, t, p, ks, staging_uri, rg_sizes)
            for (t, p), ks in by_key.items()
        ]
        for fut in as_completed(futures):
            res = fut.result()
            done += 1
            if res is None:
                continue
            tier_name, period_label, n_parts, n_bytes = res
            finals += 1
            bytes_written += n_bytes
            err(f"reduce {done}/{len(by_key)}: {tier_name:4s} {period_label} "
                f"({n_parts} partials → {n_bytes/1024:.0f} KiB)")

    err(f"done: {finals} finals, {bytes_written:,} bytes, wall {time.time() - t0:.1f}s")


if __name__ == '__main__':
    main()
