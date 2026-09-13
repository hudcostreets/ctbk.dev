# Serve-time station canonicalization — ctbk side

Status: proposed (2026-09-13). ctbk-side companion to the pyrmts spec
`pyrmts/specs/ctbk-serve-time-canonicalization.md` (the design rationale +
the engine capability live there; this file is ctbk's tracked to-do).
Follows the harmonize co-activity fix (`ctbk/stations/harmonize.py`, 2026-09-13)
and supersedes the deferred "rebuild pyramids to un-merge the 25 false merges."

## Why (one paragraph)

ctbk canonicalizes station identity at **ingest** (`rides_source.py` maps each
ride's reported id → canonical via `station-id-map.json` → `station-vocab.json`),
so merges are baked into built tiles: an id-map fix forces a genesis→now Batch
rebuild, and the pyramid can't show a merged pair separated. Move the decision to
serve time: key the pyramid by **raw reported id** (id-map-independent leaves),
**materialize** a canonical rollup with the id-map as a *dependency*, and serve
the canonical level. Then id-map corrections regen only the canonical tiles from
the leaves (no raw re-ingest) — the deferred rebuild becomes a **one-time
re-key**, and the `/merge-review` page reads the leaf level for free.

## Depends on pyrmts

The materialized canonical rollup is a new pyrmts capability (a mapping-driven
rollup, or a vocab-hierarchy cover — pyrmts's (A)/(B) call). **Everything below
is gated on that landing**, except the review page's data path, which can be
prototyped against the leaf level as soon as the re-key exists.

## Tasks

1. **Ingest → raw id.** `ctbk/pyramid_cascade/rides_source.py`: emit
   `s:<raw reported id>`, drop the canonical-map application. Update
   `test_rides_source.py` (`test_identity_sid_maps_to_own_chain` and the
   canonical-map cases) to assert leaf = raw id.
2. **Vocab.** `ctbk/pyramid_cascade/vocab.py` / `configs/pyramids/station-vocab.json`:
   raw-id vocab (~3,900 ids). Keep it a frozen-ragged addition; no id-map applied.
3. **Canonical-rollup config.** Declare the canonical level per the pyrmts
   transport, with `s3/ctbk/stations/station-id-map.json` as a declared DVX dep
   so an id-map change dirties the canonical tiles (and nothing upstream).
4. **api worker.** `gbfs/api/src/rides_v1.ts` (+ `avail_geo.ts`): serve the
   **canonical** level by default; add a param (e.g. `?raw=1` or a distinct
   route) to read the **leaf** level for the audit view. `RECONCILE_PYRAMIDS` /
   health additions if the canonical level registers separately in D1.
5. **One-time re-key** (Batch): rebuild `rides-v5-start/-end` + `avail-v6`
   (+ `avail-v5` if still served) keyed by raw id, then materialize the canonical
   level. The last mandatory genesis→now run for this class of change. Validate:
   canonical-level serve responses byte-equal the pre-re-key served values for a
   sample of **un-merged** stations (no behavior change there); the 25
   formerly-merged pairs now serve **separated** on the leaf level and
   **still-summed** on canonical only where the *corrected* id-map says so.
6. **`/merge-review` page** (new route + `StationMergeReview.tsx`): loads
   `station-merge-review.json` (already emitted by harmonize) + `station-luc.json`
   for coords; per flagged pair, a Leaflet map (both stations pinned, reuse
   `StationMap`) + a Plotly plot of each id's ride counts over time (leaf-level
   rides-v5 queries, bin-responsive), shared-active months shaded — clean hand-off
   (one line succeeds the other) vs distinct (both concurrent) obvious at a glance.
   Optionally a per-pair "these are the same / distinct" control that writes an
   override into the harmonize inputs (future).
7. **avail parity.** Same raw-id + canonical-rollup treatment for the avail
   pyramids (also `s:`-keyed) so the smg station-state plot and `?sel=` panel are
   correct for renumbered/merged stations without a rebuild-per-fix.

## Sequencing

1. pyrmts lands the rollup capability (their spec).
2. ctbk: tasks 1–3 (ingest/vocab/config) behind the new capability.
3. One-time re-key (task 5) → cut serving to the canonical level (task 4).
4. Ship `/merge-review` (task 6) against the leaf level.
5. avail parity (task 7) as a follow-on.

## Non-goals

- Era-specific identity resolution (`{id, month}` keys) — the id-map is global;
  raw-id leaves + a global map at serve time suffice.
- De-versioning names (`rides-v5`→`rides`) — orthogonal; see
  `deversion-clean-slate.md`. Do the re-key first, or fold the rename into the
  same one-time job if convenient.
