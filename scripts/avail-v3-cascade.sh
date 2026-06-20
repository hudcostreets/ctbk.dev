#!/usr/bin/env bash
# Cascade avail-v3 derived tiers from the 1m source via the single-pass
# `cascade_from_1m` path (see `specs/avail-v3-cascade-perf.md`).
#
# One streaming pass over 1m hourly shards emits all 17 derived tiers
# ({2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d, 3d, 7d, 1mo, 3mo,
# 1y}) — no intermediate-tier reads, no level barriers, no sibling
# parallelism management. Wall target on `e` (full pyramid): ~5–10 min.
#
# Usage:
#   scripts/avail-v3-cascade.sh -f 2026-04-07 -T 2026-06-18 [-c 16]
#     -f  date_from (inclusive)
#     -T  date_to   (exclusive)
#     -c  R2-fetch thread-pool size (default 16)
#     -O  pass --overwrite to the builder (default: on)
#
# Note: cascade_from_1m fully recomputes each (tier, output_period) shard
# from the 1m source rows within its window. For periods that overlap
# `[date_from, date_to)` only partially (e.g. a 1-day rebuild for a
# yearly-shard tier), the resulting shard reflects ONLY that subset —
# pass the full historical range when rebuilding the whole pyramid.
set -euo pipefail

NPROC=16
OVERWRITE="-O"
DATE_FROM=""
DATE_TO=""
LOG="${LOG:-tmp/avail-v3-cascade.log}"

while getopts "f:T:c:O" opt; do
  case "$opt" in
    f) DATE_FROM="$OPTARG" ;;
    T) DATE_TO="$OPTARG" ;;
    c) NPROC="$OPTARG" ;;
    O) OVERWRITE="-O" ;;
    *) echo "usage: $0 -f DATE_FROM -T DATE_TO [-c NPROC]" >&2; exit 2 ;;
  esac
done

[ -n "$DATE_FROM" ] || { echo "missing -f DATE_FROM" >&2; exit 2; }
[ -n "$DATE_TO" ]   || { echo "missing -T DATE_TO"   >&2; exit 2; }

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

echo "## cascade-from-1m: [$DATE_FROM, $DATE_TO) × -c $NPROC" | tee -a "$LOG"
start=$SECONDS
ctbk avail-v3-cascade-from-1m -f "$DATE_FROM" -T "$DATE_TO" -c "$NPROC" $OVERWRITE 2>&1 | tee -a "$LOG"
echo "## done — wall=$((SECONDS-start))s" | tee -a "$LOG"
