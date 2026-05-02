#!/usr/bin/env bash
# Re-trigger `compactHour` over a (date, hour) range, hitting the deployed
# compactor's `/compact?date=…&hour=…` endpoint. Used after bumping
# `rowGroupSize` to rewrite historical h1 shards with the new layout.
#
# Usage:
#   COMPACTOR_URL=https://ctbk-gbfs-compactor.<account>.workers.dev \
#     COMPACTOR_SECRET=... \
#     gbfs/regen-h1.sh                          # default: 2026-04-20 → now-1h UTC
#   gbfs/regen-h1.sh 2026-04-25                 # start date override
#   gbfs/regen-h1.sh 2026-04-25 2026-04-30 23   # full range override (incl. last hour)
#   PAR=4 gbfs/regen-h1.sh                      # 4-way parallel (default 1)
#
# Idempotent: same key, content depends only on the deployed worker's writer
# config. Re-run any time. Output also tee'd to tmp/regen-h1.log.
set -euo pipefail

URL="${COMPACTOR_URL:?set COMPACTOR_URL e.g. https://ctbk-gbfs-compactor.<sub>.workers.dev}"
SECRET="${COMPACTOR_SECRET:?set COMPACTOR_SECRET (matches wrangler secret put COMPACTOR_SECRET)}"
START="${1:-2026-04-20}"
NOW_DATE=$(date -u +%Y-%m-%d)
NOW_HOUR=$(date -u +%H)
END="${2:-$NOW_DATE}"
END_HOUR="${3:-$(( 10#$NOW_HOUR - 1 ))}"   # last completed UTC hour today
PAR="${PAR:-1}"

LOG=tmp/regen-h1.log
mkdir -p tmp
: > "$LOG"

date_seq() {
  local d="$1" end="$2"
  while [[ ! "$d" > "$end" ]]; do
    echo "$d"
    d=$(date -u -d "$d + 1 day" +%Y-%m-%d)
  done
}

one() {
  local date="$1" h="$2"
  local body code
  body=$(curl -sS -o - -w '\n__CODE__%{http_code}__T__%{time_total}' \
    -H "x-compactor-secret: $SECRET" \
    "$URL/compact?date=$date&hour=$h" 2>&1) || {
      printf 'FAIL %s %s curl-error\n' "$date" "$h"; return 1; }
  code=$(printf '%s' "$body" | sed -n 's/.*__CODE__\([0-9]*\)__T__.*/\1/p')
  t=$(printf '%s' "$body" | sed -n 's/.*__T__\(.*\)$/\1/p')
  payload=$(printf '%s' "$body" | sed 's/__CODE__.*//')
  if [[ "$code" == "200" ]]; then
    summary=$(printf '%s' "$payload" | tr -d '\n' | sed 's/.*"minutes":\([0-9]*\),"rows":\([0-9]*\),"bytes":\([0-9]*\).*/m=\1 r=\2 b=\3/')
    printf 'OK   %s %s  %ss  %s\n' "$date" "$h" "$t" "$summary"
  else
    printf 'FAIL %s %s code=%s  %s\n' "$date" "$h" "$code" "$payload"
    return 1
  fi
}
export -f one
export URL SECRET

echo "regen $START → $END (last hour: $END_HOUR), par=$PAR" | tee -a "$LOG"

{
  for date in $(date_seq "$START" "$END"); do
    hmax=23
    [[ "$date" == "$END" ]] && hmax="$END_HOUR"
    for h in $(seq 0 "$hmax"); do
      printf '%s %02d\n' "$date" "$h"
    done
  done
} | if [[ "$PAR" -gt 1 ]]; then
  xargs -n2 -P "$PAR" bash -c 'one "$0" "$1"'
else
  while read -r date h; do one "$date" "$h" || true; done
fi | tee -a "$LOG"

fails=$(grep -c '^FAIL ' "$LOG" || true)
oks=$(grep -c '^OK   ' "$LOG" || true)
printf '\nDone: %d ok, %d fail\n' "$oks" "$fails" | tee -a "$LOG"
[[ "$fails" -eq 0 ]]
