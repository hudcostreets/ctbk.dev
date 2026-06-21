#!/usr/bin/env bash
# Cut over the production avail-v3/ prefix to the new pyramid-cascade
# layout. Preserves 1m/ (base tier source), backs up derived tiers, then
# syncs avail-v3-test/ → avail-v3/.
#
# Run from anywhere; uses the `cf` AWS profile (R2 endpoint configured
# in ~/.aws/config).
#
# Steps:
#   1. Back up everything except avail-v3/1m/ to avail-v3-prior/
#   2. Delete the same (excluding 1m/)
#   3. Sync avail-v3-test/ → avail-v3/
#   4. Verify counts
#
# After this, emit the manifest via a separate `ctbk` invocation.
set -euo pipefail

BUCKET="ctbk"
SRC_PREFIX="avail-v3-test"
DST_PREFIX="avail-v3"
BACKUP_PREFIX="avail-v3-prior"
PRESERVE_SUBDIR="1m"     # keep avail-v3/1m/* untouched

S3=(aws --profile cf s3)

echo "=== Step 1: Backup avail-v3/{!1m}/ → avail-v3-prior/ ==="
# `sync --exclude "1m/*"` keeps 1m/ in source but doesn't copy it.
time "${S3[@]}" sync \
  "s3://${BUCKET}/${DST_PREFIX}/" "s3://${BUCKET}/${BACKUP_PREFIX}/" \
  --exclude "${PRESERVE_SUBDIR}/*"

echo
echo "=== Step 2: Delete avail-v3/{!1m}/ (after backup) ==="
time "${S3[@]}" rm "s3://${BUCKET}/${DST_PREFIX}/" --recursive \
  --exclude "${PRESERVE_SUBDIR}/*"

echo
echo "=== Step 3: Sync avail-v3-test/ → avail-v3/ ==="
time "${S3[@]}" sync \
  "s3://${BUCKET}/${SRC_PREFIX}/" "s3://${BUCKET}/${DST_PREFIX}/"

echo
echo "=== Step 4: Verify ==="
src_count=$("${S3[@]}" ls "s3://${BUCKET}/${SRC_PREFIX}/" --recursive | wc -l)
dst_after=$("${S3[@]}" ls "s3://${BUCKET}/${DST_PREFIX}/" --recursive | wc -l)
dst_no1m=$("${S3[@]}" ls "s3://${BUCKET}/${DST_PREFIX}/" --recursive | grep -v "/1m/" | wc -l)
echo "  avail-v3-test files:                  $src_count"
echo "  avail-v3 files total (incl 1m/):      $dst_after"
echo "  avail-v3 files excl 1m/:              $dst_no1m"
echo "  (expected: dst_no1m == src_count == 105)"
