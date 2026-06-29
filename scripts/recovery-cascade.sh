#!/usr/bin/env bash
# Wrapper for `ctbk pyramid-cascade` with disconnect-resilience safeguards:
#   - PID file for status checks
#   - Signal traps logging cause of death
#   - Background heartbeat sampling RSS every 60s to a separate log
#   - Self-cleanup of the heartbeat process on exit
#
# Intended invocation (detached from terminal session entirely):
#   nohup setsid scripts/recovery-cascade.sh <prefix> <date_from> <date_to> [<jobs>] \
#     < /dev/null > /dev/null 2>&1 &
#
# Args:
#   prefix     — R2 key prefix (e.g. `avail-v3-test` or `avail-v3`)
#   date_from  — half-open range start (YYYY-MM-DD)
#   date_to    — half-open range end   (YYYY-MM-DD)
#   jobs       — ProcessPool size for the block phase (default: 3)
#
# Logs:
#   logs/recovery-<prefix>.log   — full cascade stdout/stderr
#   logs/recovery-<prefix>.rss   — heartbeat RSS samples
#   logs/recovery-<prefix>.pid   — PID file (removed on exit)
set -euo pipefail

PREFIX="${1:?missing prefix arg}"
DATE_FROM="${2:?missing date_from}"
DATE_TO="${3:?missing date_to}"
JOBS="${4:-3}"

LOG="logs/recovery-${PREFIX}.log"
RSS_LOG="logs/recovery-${PREFIX}.rss"
PID_FILE="logs/recovery-${PREFIX}.pid"

mkdir -p logs
echo $$ > "$PID_FILE"

log()     { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
rss_log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$RSS_LOG"; }

cleanup() {
  local rc=$?
  log "=== cleanup: rc=$rc ==="
  # Kill heartbeat if alive.
  if [ -n "${HEARTBEAT_PID:-}" ] && kill -0 "$HEARTBEAT_PID" 2>/dev/null; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}
trap cleanup EXIT

trap_signal() {
  local sig=$1
  log "!!! received SIG${sig} at $(date -u +%Y-%m-%dT%H:%M:%SZ) — propagating to children"
  # Re-raise default for SIGTERM etc. so the cascade dies cleanly.
  trap - "$sig"
  kill -"$sig" $$
}
trap 'trap_signal TERM' TERM
trap 'trap_signal HUP'  HUP
trap 'trap_signal INT'  INT

log "=== start: pid=$$ ==="
log "cmd: ctbk pyramid-cascade -c configs/pyramids/avail.yaml -p $PREFIX -i avail -r ${DATE_FROM}/${DATE_TO} -j $JOBS -P overwrite"
log "host: $(hostname), free: $(free -h | awk '/^Mem:/ {print $7}')"

# Heartbeat: every 60s, snapshot RSS of every process in our session
# (setsid makes $$ the session leader, so `ps -s $sid` covers the cascade
# parent + all ProcessPool workers) + box-wide free/used. Catches slow
# leaks before they OOM the box.
SID=$(ps -p $$ -o sid= | tr -d ' ')
(
  while true; do
    sleep 60
    if ! kill -0 $$ 2>/dev/null; then exit 0; fi  # parent died, stop logging
    session_rss_kb=$(ps -s "$SID" -o rss= --no-headers 2>/dev/null | awk '{s+=$1} END {print s+0}')
    n_procs=$(ps -s "$SID" --no-headers 2>/dev/null | wc -l)
    mem=$(free -m | awk '/^Mem:/ {printf "used=%dMB free=%dMB avail=%dMB", $3, $4, $7}')
    rss_log "session_rss=${session_rss_kb}KB n_procs=${n_procs} ${mem}"
  done
) &
HEARTBEAT_PID=$!
log "heartbeat pid=$HEARTBEAT_PID (rss log: $RSS_LOG)"

# Run cascade. Append to log so the header lines are preserved.
ctbk pyramid-cascade \
  -c configs/pyramids/avail.yaml \
  -p "$PREFIX" \
  -i avail \
  -r "${DATE_FROM}/${DATE_TO}" \
  -j "$JOBS" \
  -P overwrite \
  >> "$LOG" 2>&1
CASCADE_RC=$?

log "=== cascade exit: rc=$CASCADE_RC ==="
exit $CASCADE_RC
