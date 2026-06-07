#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["click"]
# ///
"""Summarize bench-rides-v3 JSONL output: median latency per
(region, duration, backend, cache_mode), plus success rate."""
import json
import sys
from collections import defaultdict
from statistics import median
import click


@click.command()
@click.argument('jsonl', type=click.Path(exists=True))
def main(jsonl: str):
    rows = [json.loads(l) for l in open(jsonl) if l.strip()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        k = (r['region'], r['duration_label'], r['backend'], r['cache_mode'])
        groups[k].append(r)

    print(f"{'region':6s} {'dur':4s} {'backend':7s} {'mode':4s} {'ok':>5s} {'med_ms':>8s} {'max_ms':>8s} {'bytes':>6s}")
    print('-' * 60)
    for (region, dur, backend, mode), grp in sorted(groups.items()):
        ok = [r for r in grp if r['status'] == 200]
        n_ok, n = len(ok), len(grp)
        if not ok:
            print(f"{region:6s} {dur:4s} {backend:7s} {mode:4s} {n_ok:>2d}/{n:<2d} {'FAIL':>8s} {'FAIL':>8s} {grp[0]['bytes']:>6d}")
            continue
        med = median(r['latency_ms'] for r in ok)
        mx = max(r['latency_ms'] for r in ok)
        sz = max(r['bytes'] for r in ok)
        print(f"{region:6s} {dur:4s} {backend:7s} {mode:4s} {n_ok:>2d}/{n:<2d} {med:>8.1f} {mx:>8.1f} {sz:>6d}")


if __name__ == '__main__':
    main()
