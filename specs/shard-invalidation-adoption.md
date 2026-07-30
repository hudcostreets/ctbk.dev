# Shard invalidation, ctbk side: triggers, cache versioning, `RAW_FINALITY_S` retirement

Status: **open** (2026-07-30). Engine spec: pyrmts `specs/shard-invalidation.md` (journal + fsck-rebuild mechanics live there; this spec is the consumer wiring). Context: the poller-flakiness decision is **accept** — CFW `* * * * *` cron sheds ~1-4% of minutes; downstream must be robust to patchy raw data as an invariant, and repairs (when a datum *does* land late) should be event-driven rather than gated on the 15-minute wait/skip heuristic.

## Trigger surfaces

1. **Admin CLI** (primary; the only organic ctbk trigger today is manual repair/backfill): `ctbk gbfs invalidate <from> <to> [-C avail-v5]` → engine `invalidate()` on the pyramid's journal. Use cases: recovered WAL minutes, corrected ingest windows, targeted re-expansion after chain/vocab fixes (today's blunt `stale_before` covers the global version).
2. **Poller/back-writer hook** (future, only if a redundant poller or WAL back-writes ever land): after putting a WAL minute key older than the newest built shard covering it, call the api worker's `/api/invalidate` (auth'd) with the 1-minute interval. Not built until a back-writing producer exists.

## Edge-cache versioning (the TTL-semantics answer)

Max-rung shards keep their "immutable forever" story — but identity becomes *(key, content-version)* instead of key alone:

- **R2 objects**: same keys, overwritten in place on repair; the registry md5 is the version signal. No R2-side change.
- **`/api/avail-v3` / totals / rides edge cache**: today past-only windows get `max-age=86400, immutable`. Add a per-pyramid **repair generation** — a tiny counter (D1 row or R2 doc) bumped by every `invalidate` — folded into the cache key exactly like `pyramid` already is. Then past-window responses can stay long-TTL/immutable indefinitely: a repair bumps the generation and rotates every affected key; unrepaired pyramids never rotate. (Interim fallback: the existing 24h cap already bounds repair propagation to ≤24h with zero work.)
- **Public-bucket direct object URLs** (`/files` previews, external readers): served with whatever cache headers the public bucket emits — verify we're not setting long-lived `immutable` there; content changes under the same URL on repair. Acceptable staleness; note in `/files` UI if it ever matters.

## `RAW_FINALITY_S` retirement (acceptance criterion)

With invalidation live end-to-end:

- `_fill_hole_raw` (and the CFW cascade's `readRawRows` twin) drop the wait-branch: build with whatever minutes exist, no `None`-and-retry. Keep a small `CRON_JITTER_GRACE_S ≈ 120` **only** as an anti-race damper for the currently-closing period (a WAL put can be seconds in flight); everything else builds immediately.
- The 15-minute "declare lost" concept is deleted — an absent minute is just absent; if its datum ever lands, the writer (or admin) invalidates that minute and the next 5-min tick repairs the covering fine shards (≤~15 small objects, fine→coarse via the engine's dependency order).
- Health accounting: the ~15 steady-state within-grace pendings shrink accordingly (grace 15m → 2m); the soak-monitor threshold discussion mostly dissolves.

## Sequencing

1. pyrmts lands `invalidate` + journal-aware discovery (their spec).
2. ctbk: CLI subcommand + repair-generation cache keying (worker) — deployable independently, invalidation just finds nothing stale until used.
3. Flip: shrink `RAW_FINALITY_S` → `CRON_JITTER_GRACE_S=120` in `lambda_exec.py` + the CFW cascade; delete the skip-vs-wait branch in favor of build-always.
4. Soak a week; verify a synthetic repair end-to-end (delete a WAL minute from a test window, rebuild, re-add, invalidate, confirm byte-convergence to the never-deleted build).

## Related facts (established 2026-07-30, recorded here so the spec is self-contained)

- WAL keys AND data attribution both use poll wall-clock (`buildMinuteShard`: `dt = floor(polled_at/60)*60`); the feed's `last_updated` (`ts`) is stored alongside but unused for binning. Feed drift (`polled_at − ts`) is now surfaced on `/health` (latest + rolling 24h) and derivable historically from the daily compaction parquets (`ts` + `polled_at` columns). If drift proves material (p95 ≫ 60s), re-attributing `dt` to `floor(ts/60)` is a data-level change requiring a full rebuild for consistency — decide after observing the drift series; do not mix attributions across eras.
- Read path never touches raw WAL minutes: now-touching queries clamp `to` to the last closed 5-min boundary and cover the tail with `@5min+` rungs; the live edge rides `/api/stations/:id/today`.
