#!/usr/bin/env bash
# Smoke-test the new multi-scale rollup stages for one (year, month).
#
# Per `specs/multiscale-timeseries-backend.md` phase 1:
#   - hour-level region rollups (`trips/region/<r>/h1/<YYYY>.parquet`)
#   - minute-level region rollups (`trips/region/<r>/n1/<YYYYMM>.parquet`)
#   - per-station raw record file (`trips/stations/<short_name>.parquet`)
#
# Runs each stage on a single month / single station so the run is cheap
# and bugs surface fast, before kicking off a full historical backfill.
#
# Usage: smoke-rollups.sh <yyyymm> [<test-station-short-name>]
#
# Examples:
#   smoke-rollups.sh 202603
#   smoke-rollups.sh 202603 HB101
#
# Prereqs:
#   - `ctbk` CLI installed (`pip install -e .`)
#   - `ConsolidatedMonth` parquet for the given month is materialized (run
#     `ctbk norm create <ym>` + `ctbk cons create <ym>` first if needed)
#   - DVX/S3 credentials set so outputs land at `s3://ctbk/trips/...`

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <yyyymm> [<short_name>]" >&2
  exit 1
fi

ym="$1"; shift
yyyy="${ym:0:4}"
short_name="${1:-HB101}"  # default a JC station so per-station fan-in stays cheap

set -euo pipefail

# Pretty section headers for the log.
section() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }

section "Pre-req: hour-level + minute-level monthly aggregates for $ym"
ctbk agg create -g ymdhgtb  -acd "$ym"
ctbk agg create -g ymdhngtb -acd "$ym"

section "Per-region hour rollup for year=$yyyy (single month of input)"
# Note: TripsRegionH1Year normally fans in all 12 months of `ymdhgtb_cd`
# for the year. With only one month present, it should still produce a
# valid (small) parquet — that's the smoke-test value.
for region in nyc jc hob; do
  ctbk trips-region-h1 -r "$region" "$yyyy" || {
    printf '\033[0;31mtrips-region-h1 -r %s %s failed (likely missing months for the year)\033[0m\n' "$region" "$yyyy"
  }
done

section "Per-region minute rollup for $ym"
for region in nyc jc hob; do
  ctbk trips-region-n1 -r "$region" "$ym"
done

section "Per-station fan-in (whole history)"
# This stage rewrites all per-station parquets each run. If you want to
# avoid the full ~4 GB read on the smoke test, pass --only $short_name (if
# the stage supports it) or limit the month range. Adjust as needed.
ctbk trips-per-station create

section "Sanity-check the outputs"
echo "Files produced (from R2/S3 listing):"
aws s3 ls "s3://ctbk/trips/region/" --recursive 2>/dev/null | tail -20 || true
echo
echo "Per-station file for $short_name:"
aws s3 ls "s3://ctbk/trips/stations/$short_name.parquet" 2>/dev/null || true

section "Test the Worker endpoint"
api='https://ctbk-gbfs-api.ryan-0dc.workers.dev'
from_s=$(date -u -j -f "%Y%m" "$ym" "+%s" 2>/dev/null || date -u -d "${ym:0:4}-${ym:4:2}-01" +%s)
to_s=$((from_s + 31 * 86400))

echo "Region NYC, hour bins, $ym:"
curl -fsS "$api/api/query?kind=trips&region=nyc&from=$from_s&to=$to_s&bin=3600000" | head -c 500
echo

echo
echo "Per-station, hour bins, $short_name:"
curl -fsS "$api/api/query?kind=trips&station=$short_name&from=$from_s&to=$to_s&bin=3600000" | head -c 500
echo

section "Smoke test complete"
echo "Next step: hit https://ctbk.dev/s/$short_name?rollup=1 to see the chart against real data."
