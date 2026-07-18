# Drop LUC anchoring: station-ID keys + fixed coarse cells

Supersedes #161 (anchor pinning) by removing the property pinning was
patching.

## Problem

A station's LUC (level of unique containment) is *relational*: the
finest S2 cell containing it uniquely **vs all other stations**. New
stations therefore churn *existing* stations' anchors (166 moved in the
2026-07 re-key without physically moving), and since history is
materialized at anchor cells, every churn invalidates historical shards
→ denorm regen + upload + FE asset sync + full pyramid re-keys (hours
on `e`, or ~1.5-2 h/$10-15 via the Lambda fan-out — machinery that
shouldn't need to exist as a monthly ritual).

## Design

### Keying

Each observation materializes at:

- **Fixed coarse cells**: its L10..L13 ancestors (locally derived from
  its own lat/lng — neighbors can't churn them; a station that MOVES
  contributes to different coarse cells before/after, which is correct
  positional semantics, no rebuild).
- **One station-ID row**: keyed by canonical short_name (e.g.
  `s:JC115` in the same `s2_cell`-string dim). The ID is the station's
  *identity* — never collides, never moves, jitter-proof (unlike an
  L20/L21 token, which GPS noise in `station_information` could flap).

Rows/bin ≈ 440 coarse cells + 2,745 IDs ≈ **3,200 — less than
today's ~4,200** (avg 4.6-deep LUC chains). No `station-luc.json`
denorm anywhere: the FE queries `cells=s:<short_name>` directly; the
worker/Lambda write path expands via lat/lng + ID only.

### Query planning: covers over a finite vocabulary

Cover vocabulary = stored keys only: `{L10..L13 cells} ∪ {IDs}`, with
± algebra (the worker's `cells.exclude` sum-monoid negation already
implements subtraction; histograms/counts subtract exactly).

**Containment graph**: coarse cells parent by S2 containment; each
finest-level cell's children are its stations (from the registry —
lat/lngs enter ONLY when building the graph and classifying leaves).
Input: any station *set* (a geometric region is just one selector).
Output: min ± term list.

**Optimal cover is a linear two-function DP** on the graph — per-node
greedy is NOT optimal (an L12 with four partial children: `L12 − Σ
outsiders` = 1+Σoᵢ terms beats four per-child cell-forms = 4+Σoᵢ):

```
pos(node) = min terms expressing (set ∩ node)
          = min( Σ pos(children),  1 + neg(node) )      # node − complement
neg(node) = min terms expressing (node ∖ set)
          = min( Σ neg(children),  1 + pos(node) )      # symmetric
leaf (station): pos = [1 if in set else 0]; neg symmetric
```

(Compute both bottom-up; the mutual `1 +` forms reference the OTHER
function's children-sum to avoid circularity.)

**Ragged vocabulary**: the DP is depth-agnostic — L14/L15 cells can be
stored only under density-qualifying parents. Expanding the vocabulary
later is *append-only* (write the new cell's rows forward + backfill
that one cell locally; nothing else re-keys).

**Read cost per term**: 1 RG typically; 2 when the term's (key, dt)
run straddles an RG boundary; `ceil(run/2048)+1` for long windows at
fine bins.

### What's given up

Exact spatial queries at L14+ cells — which nothing serves today
(query mix: region covers at `coarsestLevel: 10`, Home, station pages,
per-pair ride maps). Arbitrary fine regions are exact via ID leaves.

## Benchmarks (validation gallery)

Build the cover-DP and assert cardinality bounds over real polygons
before migrating:

- **NYC NTAs** (Neighborhood Tabulation Areas, NYC Open Data) — the
  "colloquial neighborhoods" set.
- **Census blocks + rollups** (TIGER; `$c/jc-taxes` may have HC):
  assert e.g. "every CB ≤ N terms" and rollup subadditivity
  (tract terms < Σ its blocks' terms — verifies coarse cells earn
  their keep).

## Migration

1. pyrmts/planner: covers restricted to the stored vocabulary + the
   DP (pyrmts-side or ctbk-side helper); ID keys pass through the
   planner opaquely (exact key list, no geo math).
2. Write paths (CFW cascade, LE, rides builders): chain = L10..L13 +
   `s:<short_name>` — deletes `_luc_chains`/denorm plumbing.
3. FE: station pages query `s:<short_name>` (drop `station-luc.json`
   asset + loaders); region covers regenerated over the new vocabulary.
4. One full rebuild per pyramid (avail: Lambda fan-out ~1.5-2 h;
   rides: `e` or per-month splitting), sequenced before the next
   monthly GBFS churn to skip one more re-key ritual.
5. Delete: denorm regen job, R2 denorm keys, re-key runbook, #161.

## Open questions

1. Key spelling for ID rows (`s:JC115` vs bare short_name) — must not
   collide with S2 token space (S2 tokens are hex; bare `JC115` is
   ambiguous-ish with hex? `JC…` isn't hex, but NYC short_names like
   `5216.04` aren't either; a `s:` prefix is unambiguous and cheap).
2. Same-dock ID reuse (Citi Bike reassigning a short_name to a
   different physical station) — the one trigger pinning shared with
   LUC; handle via the existing canonicalization layer (station-id-map)
   rather than keying.
3. Coarse set L10..L13 vs L10..L14: measure with the benchmark gallery
   (boundary-term counts vs +~700 rows/bin).
