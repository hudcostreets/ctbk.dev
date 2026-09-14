# Serve-time station canonicalization — ctbk side

Status: proposed (2026-09-13, revised after pyrmts round-trip). ctbk-side
companion to the pyrmts spec `pyrmts/specs/ctbk-serve-time-canonicalization.md`
(the design rationale + the engine capability live there; this file is ctbk's
tracked to-do). Follows the harmonize co-activity fix
(`ctbk/stations/harmonize.py`, 2026-09-13) and supersedes the deferred "rebuild
pyramids to un-merge the 25 false merges."

## Why (one paragraph)

ctbk canonicalizes station identity at **ingest** (`rides_source.py` maps each
ride's reported id → canonical via `station-id-map.json` → `station-vocab.json`),
so merges are baked into built tiles: an id-map fix forces a genesis→now Batch
rebuild, and the pyramid can't show a merged pair separated. Move the decision to
serve time: key the pyramid by **raw reported id** (id-map-independent rows) and,
in the *same* shard, materialize a **canonical row per canonical class** as an
id-map-keyed monoid rollup of its raw constituents. Serve the canonical rows by
default; read the raw rows for audit. Then id-map corrections re-derive only the
canonical rows from raw rows already stored (no re-ingest, no source access) —
the deferred rebuild becomes a **one-time re-key**, and `/merge-review` reads the
raw rows for free.

## Design decision (settled with pyrmts): one vocab, not two levels

The earlier framing here proposed a separate raw "leaf level" + a materialized
canonical "level" (two file sets), with an (A) mapping-driven-transform vs (B)
vocab-hierarchy question left to pyrmts. **pyrmts's round-trip supersedes that:**
put **raw + canonical + s2 all as vocab members inside each time-bounded shard**,
one stack / one file set. The canonical row is written at build time as an
**id-map-keyed monoid rollup of its raw constituents** — the canonical→raw edge
is *supplied by the id-map* and applied at write time, so it sidesteps
`buildVocabGraph`'s geometry-driven parent walk (which can't express a
non-geometric identity edge — the real blocker for the old option B), and
`vocabCover`'s geometry-free DP serves canonical-by-default and raw-for-audit off
the *same* shard. Consequences that make this strictly better than two file sets:

- **No cross-file mixed covers.** A minimal cover already mixes s2-cell ids and
  `s:` identity keys resolved against one shard's rows; a separate canonical file
  set would turn every mixed cover into a cross-file gather. One vocab keeps the
  current query model intact.
- **Row bloat is only for merged clusters** — +1 canonical row per merged cluster
  per shard; an unmerged station *is* its own canonical (no duplicate). The extra
  is ~25 clusters' worth. "Store extra within reason" holds comfortably.
- **Materialization ↔ remap-cost is a settled trade, not a wart.** We chose
  materialization for serve speed; the price is that a map fix rewrites canonical
  rows. With the id-map a declared DVX dep + shard-scoped invalidation, blast
  radius scales with the change: fixing 2 stations dirties only shards where those
  ids have activity; a wholesale remap rewrites everything. (The only truly-free
  remap is to *not* materialize — fan out + sum at serve — which we ruled out on
  serve-speed grounds.)

## Depends on pyrmts — LANDED (2026-09-14)

The single new engine capability — *given the id-map, emit one summed canonical
row per canonical class present in a shard* — **is built, tested, and shipped**
(pyrmts `b5846c1`, `specs/pyrmts-identity-rollup.md`). What ctbk consumes:

- **Transform**: `recanonicalize_table` (pure, idempotent) + `canonicalize_shards`
  in `pyrmts.canonicalize` — a purely additive, per-shard overlay from the raw
  rows already stored (no source re-pull, no re-cascade).
- **Config**: an `identityRollup: { col, map, canonicalPrefix }` block (Python +
  JS twin). Raw leaves stay `s:<raw_id>`; canonical rollups get a **disjoint**
  namespace, `canonicalPrefix: "c:"` → `c:<canonical_id>` rows. `map` is a
  declared input → DVX dep (shard-scoped invalidation).
- **Serve selection is ctbk-side** (not a pyrmts change): pyrmts's row-matching
  is cover-agnostic; canonical-default vs `?raw=1` audit is chosen in *our*
  `vocabCover` call (`rides_v1.ts`/`avail_geo.ts`) feeding `planGeoQuery`.
- **Reactive driver** (engine): `pyrmts-engine canonicalize -r <from>/<to>
  [-m <local-map>] [-j N] <config>` — loads the declared `identityRollup.map`
  and runs `canonicalize_shards` **directly** (reads existing shards, re-derives
  from raw-in-shard; no journal rebuild, no source re-pull). This is ctbk's
  map-change fast-path.
- **Pin**: `pyrmts` dist `320dca9` (@ `f25343c`) — unchanged, the engine work was
  Python-only (no JS churn); `pyrmts-engine` image tags off `b767d35`. Bump
  `gbfs/api/package.json` + the engine job def on adoption.

ctbk-side contract notes (from the round-trip): our `station-id-map.json` is
`{alias: canonical}` with **bare ids** — apply `c:` to the *values* at build.
**Strip identity self-maps** (`k == v`, e.g. `1234.56→1234.56`) before feeding
`identityRollup.map`, else the transform emits a `c:` row duplicating one `s:`
leaf (harmless but needless bloat).

All pyrmts-side deliverables are **done** (core + JS config twin + engine
`canonicalize` driver). **Everything below is fully unblocked**, and
`/merge-review`'s data path can be prototyped against the raw rows as soon as the
re-key exists.

## Tasks

1. **Ingest → raw id.** `ctbk/pyramid_cascade/rides_source.py`: emit
   `s:<raw reported id>`, drop the canonical-map application. Update
   `test_rides_source.py` (`test_identity_sid_maps_to_own_chain` and the
   canonical-map cases) to assert the row key = raw id.
2. **Vocab (single, tri-member).** `ctbk/pyramid_cascade/vocab.py` /
   `configs/pyramids/station-vocab.json`: one vocab whose members are raw `s:`
   ids (~3,900) + s2 cells + the canonical `s:` ids. No separate leaf-only file
   set. Keep it a frozen-ragged addition; the id-map is *not* applied to raw
   members — it drives only the canonical-row rollup (task 3).
3. **Canonical rollup at build.** Declare the canonical rows per the pyrmts
   transport, with `s3/ctbk/stations/station-id-map.json` as a declared DVX dep so
   an id-map change dirties only the shards where affected ids have activity (and
   nothing upstream / no raw re-ingest).
4. **api worker.** `gbfs/api/src/rides_v1.ts` (+ `avail_geo.ts`): resolve `s:`
   station queries to the **canonical** row by default, off the same shard; add a
   param (e.g. `?raw=1`) that resolves to the **raw** rows for the audit view.
   No new D1 registration — canonical + raw live in the same shard rows, so
   `RECONCILE_PYRAMIDS` / health are unchanged.
5. **One-time re-key** (Batch): rebuild `rides-v5-start/-end` + `avail-v6`
   (+ `avail-v5` if still served) keyed by raw id, materializing the canonical
   rows in the same shards. The last mandatory genesis→now run for this class of
   change. Validate: canonical serve responses byte-equal the pre-re-key served
   values for a sample of **un-merged** stations (no behavior change there); the
   formerly-merged pairs serve **separated** under `?raw=1` and **still-summed**
   on canonical only where the *corrected* id-map says so.
6. **`/merge-review` page** (new route + `StationMergeReview.tsx`): loads
   `station-merge-review.json` (already emitted by harmonize) + `station-luc.json`
   for coords; per flagged pair, a Leaflet map (both stations pinned, reuse
   `StationMap`) + a Plotly plot of each id's ride counts over time (raw-row
   rides-v5 queries via `?raw=1`, bin-responsive), shared-active months shaded —
   clean hand-off (one line succeeds the other) vs distinct (both concurrent)
   obvious at a glance. Optionally a per-pair "same / distinct" control that
   writes an override into the harmonize inputs (future).
7. **avail parity.** Same raw-id + canonical-row treatment for the avail pyramids
   (also `s:`-keyed) so the smg station-state plot and `?sel=` panel are correct
   for renumbered/merged stations without a rebuild-per-fix.

## Merge-vetting status (answering pyrmts's round-trip question)

How thoroughly were the merges vetted? **Algorithmically, cleanly; not yet
individually by a human** — and the one-vocab design deliberately lowers the
stakes on that, since re-splitting a bad merge is a cheap canonical re-derive.

The co-activity guard (`harmonize.py`, minute-level start-collision test) produced
a perfectly bimodal cut over the 42 name-similar + <100 m candidate pairs it
flagged (`station-merge-review.json`):

- **14 merged** (treated as renumbers): **all have exactly 1 co-active month** —
  a single-month transition overlap, the signature of a renumber hand-off.
- **28 kept separate** (held distinct): **all have ≥2 co-active months** (2 → 80,
  median well above 2) — sustained concurrency, the signature of two real
  stations.

There is no overlap in the co-active-month counts between the two classes, which
is exactly the TP-vs-FP separation hypothesized (renumber ≈ 0–1 transition month;
distinct = many). Net effect on the id-map: **25 prior false merges dissolved,
944 true renumbers preserved.** The residual ambiguity is the **14 borderline**
(name-similar, exactly 1 co-month) — the set a human should still eyeball, which
is precisely what task 6 (`/merge-review`) surfaces on the site. Under one-vocab
each of those stays a one-shard-scoped canonical re-derive to flip, so shipping
the guard now and correcting individual calls later via the review page is safe.

## Sequencing

1. pyrmts lands the canonical-row rollup capability (their spec).
2. ctbk: tasks 1–3 (ingest / vocab / config) behind the new capability.
3. One-time re-key (task 5) → cut serving to the canonical row (task 4).
4. Ship `/merge-review` (task 6) against the raw rows.
5. avail parity (task 7) as a follow-on.

## Out of scope (orthogonal, do not fold in)

- **Bin-responsive station geometry.** A station's coordinate can change over its
  life (a move is often *why* it got a new id). Poly/rect→station-set resolution
  and "which stations are drawn over a time range" want a coordinate *per
  time-bin*, not a single representative coord. Canonicalization only makes this
  pre-existing gap visible; it gets its own treatment, separate from the identity
  rollup. (Flagged by pyrmts in the round-trip.)
- **Era-specific identity resolution** (`{id, month}` keys) — the id-map is
  global; raw rows + a global map at serve time suffice.
- **De-versioning names** (`rides-v5`→`rides`) — orthogonal; see
  `deversion-clean-slate.md`. Do the re-key first, or fold the rename into the
  same one-time job if convenient.
