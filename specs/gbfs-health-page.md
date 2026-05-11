# Spec: GBFS health page

> Status: **draft** (2026-05-10). Companion to `specs/r2-layout.md` (the
> destination this page targets). Builds on the `/files/*` file-browser
> seed already shipped (`b870b0fd`).

## Goal

A `/health` page that answers, in one glance, "is the GBFS pipeline OK?"
and, in two glances, "where are the gaps?" Covers both the realtime feed
(every-minute WAL ingestion) and the multi-tier rollup pyramid the audit
flagged as only-partly-built.

## Scope

In:
- WAL ingestion health (% coverage / missing-minute counts per day)
- Daily compaction health (gbfs/status/*.parquet presence per day)
- Hourly compaction health (h1 presence per hour)
- Cascade pyramid health (per `(agg, cons)` cell: presence, latest shard)
- "What this is" labelling — call out three generations of derived data
  so the layout isn't a riddle for newcomers
- Curated tree links — fast jumps from health → file browser at the
  right subtree

Out:
- Histogram of station status (live snapshot view of *all* stations) — separate page
- Cost / billing surface — separate concern
- Manifest editing — that's a CLI surface, not a page

## Data sources

Stats come from one new endpoint: `GET /api/health` on `ctbk-gbfs-api`.
Returns a JSON snapshot the page renders. Why a server-side endpoint
(vs. client-side enumeration via `/api/files/list`):

- One round-trip vs. dozens
- Stable surface for future automation (alerts, status badge, etc.)
- Worker can use its R2 binding directly — no scan-cost gymnastics

### Endpoint shape (draft)

```ts
GET /api/health → {
  generatedAt: number  // unix sec
  feed: {
    latestPoll: { key: string; date: string; time: string; uploadedAt: string }
    todayCount: number             // WAL JSONs landed today
    todayExpected: number          // minutes elapsed today (UTC)
    last7Days: Array<{ date: string; count: number; expected: number }>
  }
  compactions: {
    daily: { latestDate: string; count: number }  // gbfs/status/*.parquet
    hourly: { latestKey: string; todayCount: number }  // gbfs/avail/h1/today/*.parquet
  }
  cascade: {
    cells: Array<{
      agg: string
      cons: string
      shardCount: number
      latestKey: string | null
      latestUploadedAt: string | null
    }>
    expectedCells: Array<{ agg: string; cons: string }>  // per grid.yaml
  }
}
```

Implementation reads R2 via `bucket.list({ prefix, delimiter, limit })`
once per category. With ~5 prefixes to enumerate, total worker time
should stay under 500ms.

## Page layout

```
┌─ /health ───────────────────────────────────────────────┐
│  GBFS pipeline health                                    │
│  ─────────────────────                                   │
│                                                          │
│  Latest poll: 2026-05-10 02:50 UTC  (1 min ago) ✓        │
│  Today: 171 / 171 minute polls (100%)                    │
│  Last 7 days: ▆▆▆▇▆▆▆ (99.3%–100%)                       │
│                                                          │
│  ─ Compactions ──                                        │
│  Daily:  through 2026-05-09  ✓                          │
│  Hourly: through 02:00 today  ✓                         │
│                                                          │
│  ─ Cascade pyramid ──                                    │
│  ┌──────┬────────┬────────┬────────┬─────┐               │
│  │ agg \ │  cons  │  ...   │        │     │               │
│  ├──────┼────────┼────────┼────────┼─────┤               │
│  │  1m  │   ●    │   ●    │   ●    │  -  │               │
│  │  5m  │   ●    │   ●    │   ●    │  ●  │               │
│  │ 15m  │   ●    │   ●    │   ●    │  ●  │               │
│  │  1h  │   ●    │   -    │   -    │  ●  │               │
│  │  1d  │   ●    │   -    │   -    │  -  │               │
│  └──────┴────────┴────────┴────────┴─────┘               │
│  ● = built · - = not yet                                 │
│                                                          │
│  ─ Browse ─────────────────                              │
│  • Today's WAL JSONs → /files/gbfs/status/<today>/      │
│  • Today's cascade  → /files/avail/agg=1m/cons=1m/<today>/│
│  • Daily compactions → /files/gbfs/status/?ext=parquet   │
│  • Hourly compactions → /files/gbfs/avail/h1/<today>/    │
└──────────────────────────────────────────────────────────┘
```

## Curated tree view

Reusing the existing `/files/*` route + `<FileTree>`. The "Browse"
section on the health page is a short list of jump-links — anchored at
the most useful subtrees with human labels. Not a redesigned tree
component; just curated entry points.

(If the cascade pyramid grows enough labels to warrant a custom tree
later, the `<FileTree>` component is the right place to add a
`viewMode` prop — but that's premature.)

## Implementation steps

1. **Worker** (`gbfs/api/src/health.ts` + route in `index.ts`):
   - `getFeedHealth(r2)` — list `gbfs/status/<today>/`, count + latest
   - `getCompactionHealth(r2)` — list `gbfs/status/*.parquet`, latest h1
   - `getCascadeHealth(r2)` — for each expected cell, head/list to check presence
   - Wire as `/api/health`, JSON response
2. **Worker tests** (`gbfs/api/src/health.test.ts`):
   - Mock R2 binding, verify shape + threshold logic
3. **Page** (`www/src/pages/Health.tsx`):
   - Single fetch on mount; `useQuery` from tanstack-react-query
   - Stats panel (sections per above) + jump-link list
4. **Route** (`www/src/main.tsx`): `<Route path="/health" element={<Health />} />`
5. **Link in footer or nav** — discoverability

Each step is a separate commit.

## Out of scope / open questions

- **Realtime refresh**: page polls every minute? Auto-refresh `since=` style?
  Not in v1 — manual reload is fine. Add `<TimeAgo>` to "latest poll"
  so staleness is visible without polling.
- **Alerting**: a separate-page status badge or webhook integration is
  out. v1 is human-eyeballed.
- **Threshold colors**: green/yellow/red on coverage? Pick thresholds
  after a few days of observed data; for now plain numbers.
- **`expectedCells`**: derived from `gbfs/grid.yaml` parsed at deploy
  time, or hardcoded in the worker? Hardcoded for v1 (matches the
  cascade worker's own embedded level table in `gbfs/lib/cascade.ts`);
  refactor to read grid.yaml once one consumer is broken by drift.

## References

- `specs/r2-layout.md` — destination layout this page targets
- `specs/avail-grid.md` — cascade grid spec (source of `expectedCells`)
- `specs/done/avail-perf-pass.md` — current cascade design
- 2026-05-07 audit (in-conversation; not committed)
- Task #51 (this), #52 (layout cleanup), #53 (pyramid backfill)
