#!/usr/bin/env bash
# Cascade avail-v3 tiers above the 1m@1m source, parallelizing siblings
# that share a `derive_from` source. Each "level" runs concurrently with a
# barrier (`wait`) between levels, since each level reads its predecessor's
# output.
#
# Per-tier ProcessPool concurrency drops as we widen sibling parallelism,
# so total worker count stays ≈ NPROC (default: 16).
#
# Sibling groups (see `TIER_SPECS` in ctbk/avail_v3.py):
#   from 1m  : {2m, 3m, 5m, 10m, 15m, 30m}        (6 tiers)
#   from 30m : {1h, 2h, 3h, 6h, 12h}               (5 tiers)
#   from 1h  : {1d, 3d, 7d}                        (3 tiers)
#   from 1d  : {1mo, 3mo, 1y}                      (3 tiers)
#
# Wall-time vs sequential (rough, after a full rebuild):
#   sequential 2m..1y : ~75 min
#   parallel-by-level : ~35 min (~50% savings)
#
# Single-pass-over-1m would be a further ~2x improvement; tracked in
# specs/avail-v3-cascade-perf.md.
#
# Usage:
#   scripts/avail-v3-cascade.sh -f 2026-04-07 -T 2026-06-18 [-c 16] [-r 30m]
#     -f  date_from (inclusive)        — passed straight through
#     -T  date_to   (exclusive)        — passed straight through
#     -c  concurrency budget           — total NPROC across siblings (default 16)
#     -r  resume from this tier        — skip everything before it
#     -O  pass --overwrite to builder  (default: on)
set -euo pipefail

NPROC=16
RESUME=""
OVERWRITE="-O"
DATE_FROM=""
DATE_TO=""
LOG="${LOG:-tmp/avail-v3-cascade.log}"

while getopts "f:T:c:r:O" opt; do
  case "$opt" in
    f) DATE_FROM="$OPTARG" ;;
    T) DATE_TO="$OPTARG" ;;
    c) NPROC="$OPTARG" ;;
    r) RESUME="$OPTARG" ;;
    O) OVERWRITE="-O" ;;
    *) echo "usage: $0 -f DATE_FROM -T DATE_TO [-c NPROC] [-r RESUME_TIER]" >&2; exit 2 ;;
  esac
done

[ -n "$DATE_FROM" ] || { echo "missing -f DATE_FROM" >&2; exit 2; }
[ -n "$DATE_TO" ]   || { echo "missing -T DATE_TO"   >&2; exit 2; }

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

# Sibling groups: build one level at a time (barrier between levels), tiers
# within a level concurrently.
LEVELS=(
  "2m 3m 5m 10m 15m 30m"
  "1h 2h 3h 6h 12h"
  "1d 3d 7d"
  "1mo 3mo 1y"
)

# Apply -r: drop tiers ahead of the resume tier (within the level containing
# it; preceding levels are dropped entirely).
if [ -n "$RESUME" ]; then
  found=0
  NEW_LEVELS=()
  for lvl in "${LEVELS[@]}"; do
    if [ $found -eq 1 ]; then
      NEW_LEVELS+=("$lvl")
      continue
    fi
    new_lvl=""
    for t in $lvl; do
      if [ $found -eq 1 ] || [ "$t" = "$RESUME" ]; then
        found=1
        new_lvl="${new_lvl:+$new_lvl }$t"
      fi
    done
    if [ -n "$new_lvl" ]; then
      NEW_LEVELS+=("$new_lvl")
    fi
  done
  if [ $found -eq 0 ]; then
    echo "resume tier $RESUME not found in any level" >&2; exit 2
  fi
  LEVELS=("${NEW_LEVELS[@]}")
fi

run_tier() {
  local tier="$1" per_tier_c="$2"
  echo "================ tier=$tier (-c $per_tier_c) ================" | tee -a "$LOG"
  local start=$SECONDS
  ctbk avail-v3-build -t "$tier" -f "$DATE_FROM" -T "$DATE_TO" -c "$per_tier_c" $OVERWRITE 2>&1 | tee -a "$LOG"
  echo "tier=$tier wall=$((SECONDS-start))s" | tee -a "$LOG"
}

for lvl in "${LEVELS[@]}"; do
  n=$(echo "$lvl" | wc -w)
  # Per-tier concurrency: at least 1, share NPROC across the level.
  per_tier_c=$(( NPROC / n ))
  [ $per_tier_c -lt 1 ] && per_tier_c=1
  echo "## level: { $lvl } — $n tiers × $per_tier_c workers each = $(( per_tier_c * n )) procs" | tee -a "$LOG"
  pids=()
  for tier in $lvl; do
    run_tier "$tier" "$per_tier_c" &
    pids+=($!)
  done
  fail=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      fail=1
    fi
  done
  if [ $fail -eq 1 ]; then
    echo "ABORT: level { $lvl } had a failing tier" | tee -a "$LOG"
    exit 1
  fi
done

echo "ALL CASCADE DONE" | tee -a "$LOG"
