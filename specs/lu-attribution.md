# LU attribution: upstream `last_updated` as time-of-record

Status: **poller v2 implemented** (2026-08-03; regen still pending, bundled with drop-LUC per Sequencing). Decision: the feed's `last_updated` (LU) is the correct time-of-record for availability snapshots; the poller's wall clock (`polled_at`) is operational metadata. Requires a poller rewrite (cheap, immediate win) and a full pyramid regen (bundled with drop-LUC — see Sequencing). Companion: `specs/drop-luc-station-keys.md`.

## Feed characterization (2026-08-03, `ctbk gbfs feed probe`/`stats`)

Three 18-min probes at 3s sampling (~360 samples each): the poller's current URL (`gbfs/1.1/bkn`) with default headers, same with `Cache-Control: no-cache`, and the `gbfs/2.3/bkn` variant. Findings:

1. **LU cadence is exactly 60s at origin** (p50=60s on all probes; no LU regressions observed).
2. **Same LU ⇒ byte-identical body.** Every distinct LU (19 per probe, ~12 sightings each) had exactly one `body_md5`. Dedupe-by-LU is safe with no content hashing.
3. **The 1.1 URL is behind CloudFront with a ~60s TTL whose expiry phase is unrelated to origin regen.** Visible staleness wanders 0–60s as the phases precess — this is exactly the drift the /health TS showed wandering 17s → 93s. `Cache-Control: no-cache` is ignored (355/363 cache hits regardless). Worse, cache aliasing can swallow whole LU generations: the 1.1 probes saw one 120s LU gap that the 2.3 probe (same window) did not — the current poller can *permanently miss* an origin snapshot even while polling faithfully.
4. **The 2.3 URL surfaces each new LU ~3–5s after its stamp, consistently** (detection latency min 2.7s / p50 4.7s / p95 4.7s — its CDN refresh is phase-locked to origin regen). Same 60s cadence, no gaps. Station fields are a strict superset of what we record (adds `vehicle_types_available`). GBFS v2.3 is spec-released 2022-04-05; Lyft's `gbfs_versions.json` publishes exactly {v1.1, v2.3} — 1.1 is the legacy 2019-era endpoint our poller inherited.
5. **LU is NOT minute-aligned**: observed `lu % 60` ∈ {5, 6, 7} (origin stamps ~:05 past the minute), with ±1–2s cadence jitter (deltas 58–62s). Binning by `floor(ts/60)` is a real assignment, not a formality, and LU phase can drift across minute boundaries over time.

Reproduce: `ctbk gbfs feed probe -d 1200 -i 3 [-n] [-u <url>] > out.jsonl`, then `ctbk gbfs feed stats out.jsonl`.

## Poller v2

- **Switch to the 2.3 URL** (`https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json`). Field mapping unchanged; optionally start recording `vehicle_types_available` (additive).
- **Sample sub-minute, write on LU change.** One cron invocation per minute polls every ~10–15s (4–6 fetches via `waitUntil`; each ~1s). A fetch whose LU matches the last-written LU is dropped. Steady state: one R2 write per LU ≈ one per minute — same write volume as today, but every snapshot is captured ~≤15s after its LU stamp (vs 0–60s+ wander today), and 120s origin gaps are genuinely origin gaps.
- **Binning model**: bins are OURS — epoch-anchored, as everywhere else in the pyramids; upstream LUs simply land in whichever bin contains them. A bin aggregates however many snapshots fell in it (adjacent `/3m` bins may see 2–4 LUs; a `/1m` bin sees 0, 1, or occasionally 2 when jitter straddles a boundary). Upstream's phase (~:05 today) is not assumed and may drift.
- **One snapshot per `/1m` base bin (dedupe rule)**: the avail monoid's histogram counts are *snapshot* counts, and today's one-poll-per-minute regime gives the useful invariant `count ≡ observed minutes` — which makes histogram-derived means time-weighted for free and keeps todayCount/expected accounting meaningful. Preserve it: when two LUs land in one 1m bin, the larger LU wins ("state as of end of bin"); coarser bins then aggregate ≤N deduped minutes with no weighting question. At 60s cadence this discards almost nothing (only boundary-straddle pairs). If upstream ever moves to sub-minute cadence, revisit: either keep 1-per-1m (fine for 1m-binned pyramids) or go duration-weighted in the monoid.
- **WAL key = LU minute**: `gbfs/status/<date>/<HH-MM>.json` where `HH-MM = floor(LU/60)`. Same key shape as today (which uses poll minute). Record body stays `{ts, polled_at, stations}`. The dedupe rule falls out as last-writer-wins on the key (poller only ever writes ascending LUs). An LU gap → an absent minute key, identical semantics to today's missed-cron holes (which the source-readiness/patchy-data hardening already covers).
- **Attribution**: `buildMinuteShard` (and the compaction paths) switch `dt = floor(polled_at/60)*60` → `floor(ts/60)*60`. With LU-minute WAL keys, key-minute == dt-minute again.
- **Drift TS repurposed as the acceptance + regression alarm**: `polled_at − ts` should collapse to ~5–15s. Alert if it sustains > 60s — that means we're back on a stale cache edge (e.g. Lyft moves the 2.3 endpoint behind the 1.1-style cache) and is worth knowing immediately.

## History: full re-attribution

Every WAL record since genesis (verified back to the first key, `2026-04-07/01-16.json`) carries both `ts` and `polled_at`, and the daily compaction parquets carry both as columns — **all history re-attributes cleanly**; nothing is lost. Observed historical drift ≈ 60–95s, so re-attribution shifts most readings back by 1–2 minute bins — a real (if small) correction, uniform-ish across history.

- The rebuild reads WAL/compaction records and attributes by `ts`, ignoring which minute key a record sits under (old keys are poll-minute, new keys LU-minute; the record fields are authoritative).
- Two records mapping to the same LU-minute (drift jitter at old boundaries): keep the one with the larger `ts` (same last-writer rule as the poller). Holes are just holes.

## Era seam (temporary, erased by the rebuild)

Deploy poller v2 + the `buildMinuteShard`/compaction attribution flip together at some T0. From T0 the live edge is LU-attributed; history remains poll-attributed until the regen. The interim seam is a ≤2-minute systematic shift across T0 — invisible at the bins anyone views, and the full regen re-attributes both sides uniformly, deleting the seam. (Do not run the regen with mixed attribution rules; it's all-`ts`, one pass.)

## Sequencing (and why this is "the last full rebuild")

The regen is the expensive step, and `specs/drop-luc-station-keys.md` (migration step 4) *also* demands one full rebuild per pyramid for station-ID keys. Bundle them:

1. **Now**: poller v2 + attribution flip (this spec, no rebuild needed). New data is maximally fresh and dual-stamped either way; the longer this runs, the less of history the eventual regen "corrects".
2. **When drop-LUC lands** (planner DP + write-path key change): one combined avail regen — LU attribution + station-ID/coarse-cell keys — to a new prefix (`avail-v6`), parallel-build → cutover → GC v5. One rebuild, two data-level migrations.
3. Rides follows the same drop-LUC rebuild (no LU dimension — trip timestamps are already event times) and picks up the v5-style stack in the process: YAML ladder config, engine-built, D1 `pyramid_shards` registry, `/health` `pyramidCover` coverage, GC. See companion note in the rides discussion.

After that, remaining rebuild triggers are gone: station churn doesn't re-key (drop-LUC), attribution is settled (LU), and late data heals via shard-invalidation (pyrmts `specs/shard-invalidation.md`) instead of rebuilds.

## Open questions

- Whether to also record `vehicle_types_available` from the 2.3 feed (regular vs ebike split exists via `num_ebikes_available` already; per-type granularity is future-proofing) — cheap to add at poller v2 time, wasteful to backfill later.
- `station_information` poller (`INFO_URL`) can move to 2.3 for consistency at the same time.
- Probe re-run worth doing once from a CFW (colo-local CloudFront behavior can differ from laptop): a tiny `/probe` route on the dev worker, or just watch the drift TS after deploy — the TS is the ground truth that matters.
