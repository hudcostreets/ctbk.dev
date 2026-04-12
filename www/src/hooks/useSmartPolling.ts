const { min } = Math
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Smart polling hook that syncs to expected Lambda write times.
 *
 * Strategy:
 * 1. Burst phase: Poll at mtime+61s, +62s, +63s (3 attempts, 1s apart)
 * 2. If burst succeeds (new data) → restart cycle with new mtime
 * 3. If burst fails → exponential backoff: 10s, 20s, 30s, 60s, 2m, 5m
 * 4. Tab visibility: suspend when inactive, resume on activation
 */

/** Polling phase */
type PollPhase = 'idle' | 'waiting' | 'burst' | 'backoff'

interface PollState {
  phase: PollPhase
  attempt: number // 0-2 for burst, 0-5 for backoff
  /** The mtime we're polling against - used to detect new data */
  targetMtime: number | null
}

/** Backoff intervals: 10s, 20s, 30s, 60s, 2m, 5m */
const BACKOFF_INTERVALS_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 300_000]

/** Initial delay after mtime (61s = 60s Lambda interval + 1s buffer) */
const INITIAL_DELAY_MS = 61_000

/** Burst retry count */
const BURST_ATTEMPTS = 3

/** Format duration for logging */
function formatDelay(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

export interface SmartPollingOptions {
  /** S3 file's Last-Modified timestamp */
  lastModified: Date | null
  /** Callback to trigger a refetch */
  refetch: () => Promise<unknown>
  /** Enable/disable polling */
  enabled?: boolean
  /** Device ID for logging (optional) */
  deviceId?: number
  /** Whether currently viewing Latest mode (timestamp === null) */
  isLatestMode?: boolean
}

export interface SmartPollingResult {
  /** Current polling phase */
  phase: PollPhase
  /** Current attempt within phase */
  attempt: number
  /** Manually trigger immediate poll (resets to burst phase) */
  pollNow: () => void
}

export function useSmartPolling({
  lastModified,
  refetch,
  enabled = true,
  deviceId,
  isLatestMode = true,
}: SmartPollingOptions): SmartPollingResult {
  const [state, setState] = useState<PollState>({ phase: 'idle', attempt: 0, targetMtime: null })
  const [isTabVisible, setIsTabVisible] = useState(!document.hidden)

  // Log prefix for this device
  const logPrefix = deviceId !== undefined ? `[${deviceId}] ` : ''

  // Track if a poll is in progress
  const pollingRef = useRef(false)
  // Timer ref for cleanup
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track previous Latest mode state to detect transitions
  const wasLatestModeRef = useRef(isLatestMode)

  const lastModifiedMs = lastModified?.getTime() ?? null

  // Handle tab visibility changes
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = !document.hidden
      setIsTabVisible(visible)

      if (visible) {
        // Only log once (first device or no device specified)
        if (deviceId === undefined || deviceId === -1) {
          console.log('👁️ Tab became visible, resuming polling')
        }
        // Reset to waiting phase with current mtime as target
        setState(prev => ({
          phase: 'waiting',
          attempt: 0,
          targetMtime: prev.targetMtime, // Keep tracking same mtime until we see new data
        }))
      } else {
        if (deviceId === undefined || deviceId === -1) {
          console.log('😴 Tab hidden, suspending polling')
        }
        setState(prev => ({ ...prev, phase: 'idle' }))
        // Clear any pending timer
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [deviceId])

  // Detect transition into Latest mode - reset polling cycle
  useEffect(() => {
    const wasLatest = wasLatestModeRef.current
    wasLatestModeRef.current = isLatestMode

    // Only act on transition INTO Latest mode
    if (!wasLatest && isLatestMode && enabled && isTabVisible) {
      const now = Date.now()
      const expectedNextData = (state.targetMtime ?? 0) + INITIAL_DELAY_MS

      if (now > expectedNextData + 60_000) {
        // Been away >1 min past expected data time - poll immediately
        // Set targetMtime to now - 61s so that targetTime = now, delay = 0 → 100ms
        console.log(`${logPrefix}🔄 Returned to Latest mode (stale), polling immediately`)
        setState({ phase: 'burst', attempt: 0, targetMtime: now - INITIAL_DELAY_MS })
      } else if (state.phase === 'backoff' || state.phase === 'idle') {
        // Was in backoff or idle - reset to waiting to resume normal cycle
        console.log(`${logPrefix}🔄 Returned to Latest mode, resuming poll cycle`)
        setState(prev => ({ ...prev, phase: 'waiting', attempt: 0 }))
      }
      // Otherwise (in waiting or burst phase, <1min past expected) - just continue
    }
  }, [isLatestMode, enabled, isTabVisible, state.targetMtime, state.phase, logPrefix])

  // Detect new data arrival (lastModified changed from what we were polling for)
  useEffect(() => {
    if (lastModifiedMs === null) return

    setState(prev => {
      // If we don't have a target yet, or if we see new data, reset cycle
      if (prev.targetMtime === null || lastModifiedMs > prev.targetMtime) {
        if (prev.targetMtime !== null && lastModifiedMs > prev.targetMtime) {
          console.log(`${logPrefix}✨ New data detected, resetting poll cycle`)
        }
        return {
          phase: prev.phase === 'idle' ? 'idle' : 'waiting',
          attempt: 0,
          targetMtime: lastModifiedMs,
        }
      }
      return prev
    })
  }, [lastModifiedMs, logPrefix])

  // Initialize on first mount with data
  useEffect(() => {
    if (lastModifiedMs !== null && state.phase === 'idle' && isTabVisible && enabled) {
      setState({ phase: 'waiting', attempt: 0, targetMtime: lastModifiedMs })
    }
  }, [lastModifiedMs, state.phase, isTabVisible, enabled])

  // Perform a poll
  const doPoll = useCallback(async () => {
    if (pollingRef.current) return // Prevent concurrent polls
    pollingRef.current = true

    try {
      await refetch()
    } finally {
      pollingRef.current = false
    }
  }, [refetch])

  // Main polling effect
  useEffect(() => {
    if (!enabled || !isTabVisible || state.phase === 'idle') {
      return
    }

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    // Calculate delay based on current state
    let delay: number
    const now = Date.now()

    if (state.phase === 'waiting' || state.phase === 'burst') {
      if (state.targetMtime === null) {
        // No mtime yet, use default 60s
        delay = 60_000
        console.log(`${logPrefix}⏱️ Smart poll: no lastModified, waiting ${formatDelay(delay)}`)
      } else {
        // Calculate target time: mtime + 61s + (attempt * 1s for burst)
        const burstOffset = state.phase === 'burst' ? state.attempt * 1000 : 0
        const targetTime = state.targetMtime + INITIAL_DELAY_MS + burstOffset
        delay = targetTime - now

        if (delay <= 0) {
          // Target time is in the past, poll immediately (small delay to prevent tight loop)
          delay = 100
          if (state.phase === 'waiting') {
            console.log(`${logPrefix}⏱️ Smart poll: target time passed, starting burst immediately`)
          }
        } else {
          const targetDate = new Date(targetTime)
          const ss = targetDate.getSeconds().toString().padStart(2, '0')
          if (state.phase === 'waiting') {
            console.log(`${logPrefix}⏱️ Smart poll: next burst in ${formatDelay(delay)} (at :${ss})`)
          } else {
            console.log(`${logPrefix}⏱️ Smart poll: burst attempt ${state.attempt + 1}/${BURST_ATTEMPTS} in ${formatDelay(delay)}`)
          }
        }
      }
    } else if (state.phase === 'backoff') {
      // Exponential backoff from now
      delay = BACKOFF_INTERVALS_MS[min(state.attempt, BACKOFF_INTERVALS_MS.length - 1)]
      console.log(`${logPrefix}⚠️ Smart poll: backoff ${state.attempt + 1}/${BACKOFF_INTERVALS_MS.length}, retry in ${formatDelay(delay)}`)
    } else {
      return // Unknown phase
    }

    // Schedule the poll
    timerRef.current = setTimeout(async () => {
      timerRef.current = null

      // Capture mtime before poll to detect if new data arrives
      const mtimeBefore = state.targetMtime

      // Transition to burst phase if we were waiting
      if (state.phase === 'waiting') {
        setState(prev => ({ ...prev, phase: 'burst', attempt: 0 }))
      }

      await doPoll()

      // After poll, check if we got new data (state will have been reset by the mtime watcher)
      // We need to advance state only if we're still in the same cycle (same targetMtime)
      setState(prev => {
        // If mtime changed, the other useEffect already reset us - don't advance
        if (prev.targetMtime !== mtimeBefore) {
          return prev
        }

        // Same mtime - no new data, advance to next attempt
        if (prev.phase === 'burst') {
          if (prev.attempt < BURST_ATTEMPTS - 1) {
            // More burst attempts remaining
            return { ...prev, attempt: prev.attempt + 1 }
          } else {
            // Burst exhausted, enter backoff
            console.warn(`${logPrefix}⚠️ Smart poll: burst failed after ${BURST_ATTEMPTS} attempts, entering backoff`)
            return { ...prev, phase: 'backoff', attempt: 0 }
          }
        } else if (prev.phase === 'backoff') {
          if (prev.attempt < BACKOFF_INTERVALS_MS.length - 1) {
            return { ...prev, attempt: prev.attempt + 1 }
          } else {
            // Max backoff reached, stay at max interval
            console.warn(`${logPrefix}⚠️ Smart poll: still no data at max backoff (${formatDelay(BACKOFF_INTERVALS_MS[BACKOFF_INTERVALS_MS.length - 1])})`)
            return prev
          }
        }
        return prev
      })
    }, delay)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [enabled, isTabVisible, state, doPoll, logPrefix])

  // Manual poll trigger
  const pollNow = useCallback(() => {
    console.log(`${logPrefix}🔄 Manual poll triggered`)
    setState(prev => ({ ...prev, phase: 'burst', attempt: 0 }))
  }, [logPrefix])

  return {
    phase: state.phase,
    attempt: state.attempt,
    pollNow,
  }
}
