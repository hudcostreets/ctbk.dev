# RG manifest: D1 row-group index for parquet pyramid serving

Status: **P1 COMPLETE — live on prod, fully backfilled** (2026-08-08). Both anchors 243/243 keys filled (486 fills, 699,715 `rg_manifest` rows ≈ $1.40 of D1 writes — ~7× the draft's estimate, which undercounted RG density); every tier × anchor serves 0.31-0.62s cache-busted on prod, ~4ms on edge HITs. Backfill ran via `ctbk gbfs manifest backfill -e prod` (laptop loop → per-key server-side `manifest_fill` op; two laptop-sleep interruptions resumed cleanly off the fills sentinel). P2 in its pragmatic form: run `ctbk gbfs manifest backfill` after each monthly `engine submit` (lazy fill covers stragglers regardless); deeper writer-side integration deferred to P3/avail-v6 where shard churn is continuous. `gbfs/api/src/rg_manifest.ts` + `fetch_guard.ts`; D1 tables `rg_manifest` / `rg_manifest_schema` / `rg_manifest_fills` created (prod DB, shared with dev). Measured (3-station × 1y, `bin_budget=1460`): cold (footer fallback + lazy fill) ~3.3s → manifest-served **0.47-0.62s** → edge-cache HIT ~4ms; responses byte-equal across paths; 16-concurrent hammer 16/16 200s (0.88-1.79s), zero 1101/1102s. Implementation deltas vs the original draft below: (a) completeness sentinel table `rg_manifest_fills` written LAST per fill (a fill that dies midway is never trusted — plain `COUNT(*)>0` presence would silently drop RGs); (b) the footer guard poll-waits for a slot (own-request timer — safe where cross-request queuing 1101s) instead of shedding immediately, so cold multi-segment requests parse in waves rather than 503ing; (c) `FOOTER_FETCH_MAX_INFLIGHT = 1` — cap 2 still OOM'd when start+end anchors both parsed their `1d/1024d` shards (7.9MB footers, the ladder's biggest) concurrently. Backfill CLI + P2/P3 still pending. Successor to the interim OOM mitigations in `specs/rides-v5.md` §"Footer pathology"; supersedes the `rg_size: 16384` rebuild plan proposed there (shelved — see §Why not just bigger row groups).

## Problem

pyrmts' CFW read path (`fetchShardData`) fetches and thrift-parses each shard's **entire parquet footer** per shard, per request, before it can prune row groups. The big rides-v5 shards (12h/512d = 245MB, 1d/1024d = 285MB; `rg_size: 2048`) carry 5.6–6.3k row groups and **7–8MB serialized footers** (~60k column-chunk metadata entries). hyparquet materializes each as a JS object graph ~10× the serialized size. Consequences, all observed in prod 2026-08-07:

- **Latency**: ~4.5s cold per anchor request (footer fetch + parse dominates; cpuTime up to 2.7s).
- **Memory**: a few concurrent requests stack footer graphs past the isolate's 128MB limit → `exceededMemory` kills every in-flight request with a CORS-less 503 (the FE sees CORS errors + `net::ERR_FAILED`).
- **Waste**: ~8MB of footer I/O + parse to ultimately serve ~14KB of gzipped response. The *data* reads are already near-optimal (~150–500KB of RG slices); the metadata is ~95% of the cost.

Interim mitigations (deployed): sequential per-request segment fetch, in-flight cap 2 with CORS'd 503 load-shed, 1h live-window edge TTL, FE 15-min "now" quantization. These make the endpoint reliable but leave cold latency at ~4.5s and cap concurrency.

## Idea

A D1 table mirrors every shard's per-row-group metadata: byte span + `cell`/`dt` column statistics + enough column-chunk metadata to decode the RG without ever reading the file's footer. Serving then becomes:

1. Plan (unchanged — D1 `pyramid_shards` inventory).
2. **One D1 query** over the plan's keys: return the RGs whose `cell`/`dt` stats overlap the request.
3. **Parallel R2 range reads** of the matched RG byte spans (a parquet RG's column chunks are contiguous, so one coalesced run = one range read).
4. Decode each slice via hyparquet with a **synthetic single-RG metadata object** built from the manifest row; stitch/reduce unchanged.

Expected cold latency: D1 ~20–60ms + parallel range reads ~100–200ms + decode ~tens of ms → **sub-500ms**, from ~4.5s. Peak memory: no footer graphs at all → the OOM class disappears; the in-flight cap and sequential-fetch mitigations can be removed.

### Why not just bigger row groups?

`rg_size: 2048 → 16384` shrinks footers 8× (a Batch regen per anchor) but (a) still parses ~1MB of footer per shard per request, (b) coarsens RG pruning ~2–4× (more waste rows per station read), and (c) leaves the footer-parse pattern in place for the next pyramid that scales up. The manifest keeps the *fine* RGs — precision becomes an asset (fetch ≈ 150–500KB per multi-station query, within ~10× of the theoretical floor) — and removes footer work entirely. The regen stays shelved as a fallback if the manifest disappoints.

## Non-goals / trust model

**The manifest is a best-effort cache, never an authority.** Lesson from the D1 registry split-brain (`specs/done/…`, memory: fix-of-record = worker reconcile cron): correctness must not depend on D1 agreeing with R2. Concretely:

- A manifest **miss** (no rows for a key), **staleness mismatch** (see §Staleness), or **decode error** on a fetched slice → fall through to the existing footer-parse path for that key, serve correctly, and `ctx.waitUntil` a manifest (re)fill.
- The planner's source of truth remains `pyramid_shards` + R2; the manifest never influences *which* shards serve a query, only *how* their bytes are located.
- Deleting the entire manifest table at any time degrades latency, never correctness.

## Schema

```sql
CREATE TABLE rg_manifest (
  pyramid          TEXT    NOT NULL,   -- e.g. 'rides-v5-start'
  key              TEXT    NOT NULL,   -- R2 key, matches pyramid_shards.key
  shard_written_at INTEGER NOT NULL,   -- pyramid_shards.written_at this fill was built against
  rg_idx           INTEGER NOT NULL,
  row_start        INTEGER NOT NULL,   -- cumulative row offset (hyparquet rowStart/rowEnd)
  num_rows         INTEGER NOT NULL,
  byte_start       INTEGER NOT NULL,   -- RG byte span in file (contiguous col chunks)
  byte_end         INTEGER NOT NULL,
  cell_min         TEXT,               -- column stats used for pruning
  cell_max         TEXT,
  dt_min           INTEGER,
  dt_max           INTEGER,
  chunk_meta       TEXT    NOT NULL,   -- JSON: per-column {offsets, compressed/uncompressed sizes, codec, encodings, type} — everything needed to reconstruct a hyparquet single-RG metadata object
  PRIMARY KEY (pyramid, key, rg_idx)
);
CREATE INDEX rg_manifest_prune ON rg_manifest (pyramid, key, cell_min, cell_max);
```

Schema (parquet `SchemaElement[]`) is identical across a pyramid's shards → stored once per pyramid in a tiny `rg_manifest_schema (pyramid, schema_json)` table (or embedded in worker code for the known pyramids; table preferred — no deploy per pyramid).

Sizing at `rg_size: 2048`, rides-v5 both anchors: ~100k RGs × (~1KB `chunk_meta`) ≈ ~100MB, ~200k indexed row-writes ≈ **$0.20** per full fill (D1 pricing ≈ $1/M rows written, ×2 with the index — negligible here; re-check if a pyramid changes the math).

## Staleness

Shards can be **rewritten in place at the same key** (invalidation-journal repairs, fill-driver regen). Guard: manifest rows record the `pyramid_shards.written_at` they were built against; the serving join compares it against the registry row already fetched for planning. Repairs re-register through the registry proxy with a fresh `written_at` → stale manifest rows fail the join → clean miss → footer fallback + refill. (`written_at`, not etag: no `pyramid_shards` schema change, no extra HEAD per query; the journal-mtime cache-generation continues to handle *edge-cache* staleness exactly as today — the two mechanisms are independent.)

Residual hole: a rewrite that skips re-registration leaves `written_at` unchanged and the manifest stale. Last-resort guard: hyparquet decode failure on a manifest-located slice → catch, drop the key's manifest rows, fall back to footer path, refill. (Reconcile cron only registers *stranded* keys, so it does not bump rewritten-in-place keys — re-registration is the fill driver's job, as today.)

Refills must `DELETE FROM rg_manifest WHERE pyramid=? AND key=?` before inserting (RG count can change across rewrites; `INSERT OR REPLACE` alone would leave orphan high-`rg_idx` rows).

## Serving flow (worker)

Per plan segment key (after `planGeoQueryFromInventory` — unchanged):

1. Query manifest rows: `WHERE pyramid=? AND key IN (…) AND shard_written_at=?(per key) AND dt overlap AND cell overlap`. Cell predicate: OR of per-token `(cell_min <= tok AND cell_max >= tok)` conditions, chunked under D1's 100-bind limit (same chunk+UNION pattern as `d1.js`). For `s:` station keys the tokens are lexically adjacent, so matched RGs coalesce into few runs; for large vocab-cell covers (Home-scale), P1 simply skips the manifest path (see §Phasing).
2. If a key has zero manifest rows (vs. "rows exist but none match" — distinguishable by a per-key `COUNT` in the same query or a cheap second query): **fallback** for that key → existing `fetchShardData` footer path + `ctx.waitUntil(fillManifest(key))`. Mixed per-key manifest/fallback within one request is fine.
3. Coalesce adjacent matched RGs into runs; one R2 range read per run, all runs in parallel (bounded fan-out, e.g. 8).
4. Decode each run: synthetic hyparquet metadata `{schema, row_groups: [reconstructed RGs], num_rows}` over an AsyncBuffer that serves the already-fetched bytes (offsets are absolute file offsets; supply a slice-backed buffer). Existing row-level cell filtering, `stitch`, `reduceRows` unchanged.
5. `fillManifest(key)`: parse the footer once (the thing we're avoiding on the hot path — acceptable in `waitUntil`), emit ALL RG rows for the key in D1 batches (~90 rows/statement), stamped with the registry `written_at`.

Where it lives: P1 in `gbfs/api` directly (import hyparquet; bypass `pyramid.storage.fetchSegment` for manifest-served keys). Graduate into pyrmts-cfw as a manifest-aware Storage/Backend flavor once proven (pyrmts spec ask at that point, not before).

## Population

- **P1 (lazy)**: worker fills on miss, per key, via `waitUntil` — self-healing, covers all historical shards without a campaign. First query per (key, generation) pays today's cost; everything after is fast.
- **Backfill CLI**: `ctbk gbfs manifest backfill <pyramid>` — iterate `pyramid_shards`, range-read footers (pyarrow), bulk-insert via the registry proxy (new `manifest_put` op, `REGISTRY_SECRET`-authed). Run once from `e`/laptop per pyramid so first users never hit the slow path. Also `ctbk gbfs manifest {status,drop}` for ops.
- **P2 (writer-side)**: the engine/fill drivers already register shards through the registry proxy; extend that flow to also emit manifest rows. pyarrow exposes everything needed post-write (`rg.column(i)` offsets/sizes/codec; `row_start` cumulative). No pyrmts-py changes required — this is the ctbk-side registration wrapper. Lambda extension rungs (avail) do TS-side writes; they gain the same emit when P3 extends coverage.

## Phasing

- **P1 — rides-v5, `cells=s:…` queries only** (station multi-select + StationDetail rides): manifest serve + lazy fill + backfill CLI. Prove the latency/memory win with zero build-side changes. Success gate: cold multi-select pair < 1s wall, zero `exceededMemory` in a 16-concurrent hammer, then remove the in-flight cap + sequential-fetch mitigations (keep the load-shed as a dead-man's guard at a higher threshold).
- **P2 — writer-side population** at registration; backfill CLI becomes repair-only.
- **P3 — coverage**: rides-v5 bbox/vocab covers (chunked cell predicates), then avail-v6 (same footer cliff: 5.4MB footers on 534MB shards; currently one bad query away from the same incident), then rides-v3 while it still serves Home (or skip if #177 cutover lands first).

  *P3 avail progress (2026-08-08)*: `serveGeoReduced` gained the manifest path for all-`s:` covers with no excludes (the StationDetail avail shape) on the vocab pyramids; `cellCol` parameterized (`s2_cell` for avail vs rides' `cell`). **Fill floor** `MIN_FILL_RGS = 512` added on both lazy fills and the backfill op: avail's Lambda-churned tip shards (8k+ of avail-v5's 8,270 registered keys) have sub-MB footers that parse in tens of ms via fallback — filling them would just burn D1 writes on every rewrite (~$10/mo naively). The backfill CLI mirrors the floor client-side (`--min-bins`, derived from the key's `{tier}/{shard}` durations) so it doesn't POST thousands of parse-then-skip ops. Fill-worthy: avail-v5 204 + avail-v6 168 keys ≈ ~$2 of writes. Dev-verified byte-equal cold/warm: avail-v6 1.9s → 0.52s; avail-v5 2.7s → 0.99s. Vocab-cell/bbox covers + rides-v3 remain out of scope (chunked predicates).

## Acceptance

1. Byte-equality: manifest-served response ≡ footer-served response for a matrix of (station sets × ranges × bin budgets) — same records, same plan.
2. Staleness drill: rewrite a shard (invalidate + repair), verify the manifest misses cleanly (join fails on `written_at`), serves via fallback, refills, and the refilled rows decode.
3. Hammer: 16 concurrent cold wide-window requests → 0 memory kills, p95 < 1.5s.
4. Kill-switch drill: `DROP TABLE rg_manifest` mid-traffic → serving degrades to today's path, no errors.

## Open questions

- `chunk_meta` compactness: full per-column JSON (~1KB/RG) vs. minimal (offsets + sizes only, reconstruct encodings from schema defaults). Start full; measure D1 storage.
- D1 read-replication sessions for the manifest query (read-mostly, tiny rows — the pattern replication is for; #98 precedent).
- Whether a `s:`-only "station-identity satellite pyramid" (tiny shards, only identity rows) is still worth it post-manifest — manifest likely makes it unnecessary; revisit only if station-query volume grows.
