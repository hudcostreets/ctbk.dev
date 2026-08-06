# Shard invalidation, ctbk side: triggers, cache versioning, `RAW_FINALITY_S` retirement

Status: **deployed, synthetic-repair E2E green; soaking** (2026-08-05; spec 2026-07-30).

**Synthetic repair E2E (2026-08-05, prod `avail-v5`)** — sequencing step 4, passed on all criteria: `ctbk gbfs invalidate 2026-08-01T12:00 2026-08-01T12:01` appended at 23:30:54Z; the next v5 tick (:33) rebuilt all 13 overlapping shards in place, fine→coarse (`/1m@2d` 23:33:59 → `/1d@4d` 23:36:14), **every etag byte-identical** to pre-repair (byte-convergence: same inputs → same bytes); journal pruned to `[]` at 23:36:18 (4s after the coarsest rebuild; ~5.5 min append→pruned end-to-end); edge cache rotated (pre-invalidate cached window → MISS under the new `gen`, re-request HIT, content byte-equal); `/health` clean (`totalMissing=0`). Remaining: passive week-long soak under the 2-min grace. Engine spec: pyrmts `specs/shard-invalidation.md` (journal + fsck-rebuild mechanics live there — implemented, R2 If-Match live-smoke green 2026-08-05, consumed via the `ce770e7` pin; `run_extension_fill(honor_invalidations=True)` is the upstream default, so the Lambda fill ticks consume the journal as soon as the image bakes the new pin).

Implemented (2026-08-05):

- **CLI**: `ctbk gbfs invalidate [-C avail-v5] FROM TO` appends to the pyramid's journal via `pyrmts_engine.invalidation.invalidate` (etag-CAS'd); `-l/--list` prints the journal.
- **Cache versioning**: `repairGeneration(bucket, pyramid)` in `gbfs/api/src/avail_geo.ts` — the journal object's R2 **mtime** (not etag: an emptied journal's content is identical across repair cycles, so etag-keying would resurrect pre-repair entries) folded into the `/api/avail-v3` cache key as `gen=`, next to the resolved-`pyramid` fold. In-isolate 60s TTL bounds the HEAD. Journalless pyramids pin `gen=0`; totals/rides adopt the same helper if/when their pyramids get journals (totals' availability arm is legacy/zero-traffic, slated for removal).
- **Finality flip**: `RAW_FINALITY_S`/`RAW_FINALITY_MS` (15 min) → `CRON_JITTER_GRACE_S`/`_MS` (120 s) in `lambda_exec.py` + `cascade.ts`; the wait-branch survives only as the anti-race damper for the currently-closing period. The "declare lost" concept is gone — late data repairs via the journal. Context: the poller-flakiness decision is **accept** — CFW `* * * * *` cron sheds ~1-4% of minutes; downstream must be robust to patchy raw data as an invariant, and repairs (when a datum *does* land late) should be event-driven rather than gated on the 15-minute wait/skip heuristic.

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

## Related facts (2026-07-30, updated 2026-08-05)

- ~~WAL keys AND data attribution both use poll wall-clock~~ **Superseded**: the drift question resolved in favor of LU attribution (`specs/lu-attribution.md`) — poller v2 (2026-08-04 cutover) keys WAL minutes by `last_updated` and `buildMinuteShard` attributes `dt = floor(ts/60)*60`; `polled_at` is operational metadata. Pre-cutover history re-attributes in the avail-v6 regen (engine raw-ingest accepted 2026-08-05, pyrmts `specs/engine-raw-ingest.md`).
- Read path never touches raw WAL minutes: now-touching queries clamp `to` to the last closed 5-min boundary and cover the tail with `@5min+` rungs; the live edge rides `/api/stations/:id/today`.
