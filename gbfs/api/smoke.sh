#!/usr/bin/env bash
# Latency smoke-test for gbfs/api availability endpoints. Hits 4 common query
# shapes and prints time_total + size per call. Exits 1 if any call exceeds
# its budget (in seconds, as `BUDGET_*` env vars; defaults below).
#
# Usage:
#   ./smoke.sh                              # against prod
#   API='http://localhost:8787' ./smoke.sh  # against `wrangler dev` (or --remote)
#   STATION=HB101 DATE=2026-04-26 ./smoke.sh
set -euo pipefail

API="${API:-https://ctbk-gbfs-api.ryan-0dc.workers.dev}"
STATION="${STATION:-HB101}"
DATE="${DATE:-$(date -u -d yesterday +%Y-%m-%d 2>/dev/null || gdate -u -d yesterday +%Y-%m-%d)}"
SINCE="$(($(date -u +%s) - 120))"
FROM=$(date -u -d "$DATE 12:00:00" +%s 2>/dev/null || gdate -u -d "$DATE 12:00:00" +%s)
TO=$(date -u +%s)

# Budgets in seconds. Override via env.
BUDGET_TODAY="${BUDGET_TODAY:-1.0}"
BUDGET_TODAY_SINCE="${BUDGET_TODAY_SINCE:-0.7}"
BUDGET_RANGE_DATE="${BUDGET_RANGE_DATE:-1.5}"
BUDGET_RANGE_FROM_TO="${BUDGET_RANGE_FROM_TO:-2.0}"

fail=0

probe() {
    local label="$1" budget="$2" url="$3"
    local out tt size code
    out=$(curl -s -o /dev/null -m 30 -w '%{http_code} %{time_total} %{size_download}' "$url")
    code=$(awk '{print $1}' <<<"$out")
    tt=$(awk '{print $2}' <<<"$out")
    size=$(awk '{print $3}' <<<"$out")
    if [ "$code" != '200' ]; then
        printf 'FAIL %s — HTTP %s — %s\n' "$label" "$code" "$url"
        fail=1
        return
    fi
    if awk -v t="$tt" -v b="$budget" 'BEGIN{exit !(t>b)}'; then
        printf 'SLOW %s — %ss > budget %ss (%sB) — %s\n' "$label" "$tt" "$budget" "$size" "$url"
        fail=1
    else
        printf '  OK %s — %ss (%sB)\n' "$label" "$tt" "$size"
    fi
}

probe '/today (full day)'          "$BUDGET_TODAY"        "$API/api/stations/$STATION/today"
probe '/today (warm cache)'        "$BUDGET_TODAY"        "$API/api/stations/$STATION/today"
probe '/today?since=<2min>'        "$BUDGET_TODAY_SINCE"  "$API/api/stations/$STATION/today?since=$SINCE"
probe '/range?date=yesterday'      "$BUDGET_RANGE_DATE"   "$API/api/stations/$STATION/range?date=$DATE"
probe '/range?date=… (warm)'       "$BUDGET_RANGE_DATE"   "$API/api/stations/$STATION/range?date=$DATE"
probe '/range?from=&to= (~2 days)' "$BUDGET_RANGE_FROM_TO" "$API/api/stations/$STATION/range?from=$FROM&to=$TO"

exit "$fail"
