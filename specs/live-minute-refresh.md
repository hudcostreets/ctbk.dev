# Spec: Live Per-Minute Refresh on `/s/:slug`

## Goal

The station detail page's **availability chart** (not the monthly trips one)
should auto-refresh every minute, in sync with the upstream GBFS poll cycle.
New data should appear within seconds of landing in the D1 `availability_*`
table.

## Pattern (from awair)

awair has the same shape: a worker/Lambda appends a row every minute,
and the web app auto-updates.

Key awair files:
- `www/src/hooks/useSmartPolling.ts` — polling state machine
- `www/src/components/DevicePoller.tsx` — headless orchestrator
- `www/src/services/awairService.ts` — data fetching + refresh
- `www/src/lib/timeRangeCodec.ts` — URL encoding

awair's `useSmartPolling` pattern:

1. **Burst phase** on new data detection: poll at `mtime + 61s`, `+62s`,
   `+63s` (3 attempts, 1s apart).
2. **Success**: restart cycle with new mtime; log end-to-end latency.
3. **Failure** (upstream didn't write yet): exponential backoff
   10s → 20s → 30s → 60s → 2m → 5m.
4. **Tab visibility**: suspend when hidden; resume on focus.

Also:
- Separates "check for new data" (poll S3 HEAD for `Last-Modified`) from
  "read cached data" (row-group-level cache with Range Requests).
- `isLatestMode` gate — only polls when viewing newest data. When user has
  scrolled to a historical range, no polling.

## Behavior

### Initial load
1. Fetch `/api/stations/:id/today` → get all of today's rows.
2. Compute `lastPolled = max(row.polled_at)`. Example: `1775963102` (UTC seconds).
3. Observe the offset: `lastPolled % 60` → e.g. `42` seconds.
4. Schedule next refresh: `(nextMinuteBoundary + offset + jitterMs)`.

### Subsequent polls
- Fetch only new rows since `lastPolled` (add a `since=<unix>` query param,
  or use a smaller endpoint like `/api/stations/:id/latest`).
- Append to in-memory state; chart updates.
- Reschedule for (current polled_at) + 60 + small jitter.

### Missed polls / catch-up
- If a refresh is late (e.g. tab was backgrounded): fetch all rows since
  the last seen `polled_at`. Backfill into state.
- If the worker missed a minute upstream: no-op, poll again next minute.

### Visibility handling
- Use the Page Visibility API: when the tab is hidden, back off (poll every
  N minutes or pause entirely). When it becomes visible, do an immediate
  catch-up fetch.

## API Changes

Add `/api/stations/:id/since?ts=<unix>` (or extend `/today`):

```
GET /api/stations/:id/today?since=1775963102
→ { rows: [...rows with ts > since...] }
```

Cache: very short (1–5 seconds) for the incremental fetch; 60s for the
full `/today`.

## Frontend Implementation

```ts
function useLiveAvailability(stationId: string) {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const fetchInitial = async () => {
      const res = await fetch(`/api/stations/${stationId}/today`).then(r => r.json())
      if (cancelled) return
      setRows(res.rows)
      scheduleNext(res.rows)
    }

    const scheduleNext = (currentRows: Row[]) => {
      if (cancelled) return
      const last = Math.max(...currentRows.map(r => r.polled_at), 0)
      const offsetSec = last % 60
      const now = Date.now() / 1000
      const nextBoundary = Math.ceil(now / 60) * 60
      const nextPoll = nextBoundary + offsetSec + 3  // +3s jitter buffer
      const delayMs = Math.max(5000, (nextPoll - now) * 1000)
      timer = setTimeout(fetchIncremental, delayMs)
    }

    const fetchIncremental = async () => {
      if (document.hidden) { scheduleNext(rows); return }
      const last = Math.max(...rows.map(r => r.polled_at), 0)
      const res = await fetch(`/api/stations/${stationId}/today?since=${last}`).then(r => r.json())
      if (cancelled) return
      if (res.rows.length) setRows(prev => [...prev, ...res.rows])
      scheduleNext([...rows, ...res.rows])
    }

    fetchInitial()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [stationId])

  return rows
}
```

## Factoring

This pattern (intraminute offset + burst-retry + backoff +
visibility-aware + isLatestMode gate) repeats across awair and ctbk;
likely useful elsewhere too. awair has a fairly mature implementation
(`useSmartPolling`). Initial path: port it here, keep API compatible,
factor later into a shared package.

See `specs/multi-scale-ts-library.md` for the broader factoring vision.

## Open Questions

- Should we support WebSockets / SSE for true push? Simpler polling is
  probably fine at 1/min and avoids infra complexity.
- How to handle clock drift between client and server?
- For stale tabs (hidden for hours), should the catch-up fetch chunk the
  request or grab it all? `/today?since=` naturally caps at the day.
