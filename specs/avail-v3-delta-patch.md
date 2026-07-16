# avail-v3 delta patch: partial re-key without a full rebuild

## Motivation

A `station-luc.json` change currently invalidates the whole avail-v3
pyramid: every shard materialized rows at `L10..LUC` for every
station, so any station whose LUC cell changed makes every shard
covering its active period stale. The 2026-07-15/16 re-key (166
churned stations of ~2,475) cost ~2.5 h of 16-core wall time plus an
incident (see `specs/avail-v3-ladder-view-split.md`).

But the pyramid's monoid is additive: each shard row is
`(cell, dt, metric) → {state: count}` histograms. A station moving
cell A → cell B is expressible as a **delta**: subtract its per-bin
histograms from A's chain (old L10..LUC ancestors that changed) and
add them to B's chain. ~166 stations × ~95 K minutes ≈ 79 M
datapoints vs ~5.6 B for a full rebuild — ~70× less compute; wall
time becomes I/O-bound shard patching, est. 5-15 min.

## Design

### 1. Denorm snapshots

`ctbk station-luc-build` uploads to `station-luc.json` (+ the
`gbfs/station-luc.json` alias). Add: before overwriting, server-side
copy the current object to `station-luc.prev.json`. The
`(prev, current)` pair defines the diff; no local state needed.

### 2. `ctbk station-luc-diff [OLD] [NEW]`

Defaults: `OLD=station-luc.prev.json`, `NEW=station-luc.json` (R2
keys; local paths also accepted). Output (stdout JSON):

```json
{
  "changed": {
    "<short_name>": {
      "uuid": "...",
      "old": {"cell": "89c25901", "level": 15},
      "new": {"cell": "89c2590c4", "level": 16}
    }, ...
  },
  "added":   {"<short_name>": {...new entry...}},
  "removed": {"<short_name>": {...old entry...}}
}
```

Per-station affected cell-chains: `chain(e) = ancestors(e.cell,
L10..e.level)`. The patch set for a changed station is the symmetric
difference `chain(old) △ chain(new)` — shared coarse ancestors
(usually L10..L13) drop out, so most stations patch only 2-6 cells.

`added` stations need pure insertion (their rows were previously
dropped as unmapped or keyed under a fallback), `removed` pure
deletion. Same mechanism — one signed delta per (cell, dt, metric).

### 3. `ctbk avail-v3-patch --diff <diff.json> -r <range>`

For each changed/added/removed station:

1. Read its raw WAL series once (station-filtered scan of
   `gbfs/avail/agg=1m/...` minute files — or, cheaper, filter the
   fresh `/1m` min-cover shards by the station's old+new cells and
   reconstruct its per-bin histograms; raw is simpler and always
   correct).
2. For every tier: bucket the series by `tier.bin`, producing
   `(dt_bin, metric) → {state: count}`.
3. Emit signed deltas: `-1 ×` counts at old-chain-only cells,
   `+1 ×` at new-chain-only cells.
4. Group deltas by (tier, rung, period) per the **merged** ladder
   min-cover (the same view GC uses — see ladder-view-split spec),
   then read-modify-write each affected shard: parquet → histogram
   add/subtract → parquet, same key.

Histogram subtraction must clamp at zero and warn on underflow
(indicates the WAL series and the shard disagree — shard was built
from different data; fall back to full rebuild of that shard).

D1: same-key overwrites need no registry change; emit the usual
`fsck-d1-record.sql` refresh (`written_at`) for audit.

### 4. Decision rule (wired into the auto-rebuild workflow)

```
diff = station-luc-diff
if changed+added+removed == 0:      no-op
elif Σ affected (shard) writes < ~40% of full-cover shard count:
                                    avail-v3-patch
else:                               full rebuild (-M -B <now>)
```

Every shard in the pyramid gets touched by a patch when >~half the
stations churn, at which point read-modify-write costs more than
rebuild-from-raw — hence the cutover.

## Correctness argument

- The pyramid is a sum of per-station contributions; contributions
  are independent per (cell, dt, metric).
- A station's contribution to old-chain cells is exactly the series
  the patch subtracts (recomputed from the same immutable raw WAL the
  original build read).
- Adding it at the new chain is the same computation the full rebuild
  would do.
- All other stations' contributions are untouched.

Verification: after patching, rebuild ONE affected shard per tier
from raw (`--stale-before now` on just those keys, or `-T`/`-D`
filters) and byte-compare... parquet writes aren't canonical, so
compare row-level content (sorted) instead. `dvx diff`-style
row-equality on (cell, dt, metric, hist) suffices.

## Non-goals

- Rides-v3: same idea applies (and rides' immutable monthly sources
  make it even cleaner) but rides rebuilds are cheap enough per-month
  that targeted month rebuilds already work; revisit if denorm churn
  becomes frequent.
- Patching `lambda_shards` rungs owned by the AWS Lambda executor:
  the patch tool writes them directly (it runs on `e`/CI, not in a
  Lambda); no executor involvement needed.

## Estimated effort

~2-3 days: diff cmd (½ d), patch engine + clamping/underflow (~1 d),
verification harness + tests (~1 d). Prereq for making denorm bumps a
non-event in the auto-rebuild workflow
(`specs/avail-v3-auto-rebuild-gha.md`).
