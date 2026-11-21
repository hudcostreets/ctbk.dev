# avail-v3 StationDetail tail coverage — debug note for ctbk side

> **Superseded** (spec triage, 2026-11-19): avail-v3 debug note; avail-v3 retired for v5/v6.

## TL;DR

`pyrmts.planQuery` ALREADY walks finer tiers to cover the tail past the
picked output tier's authoritative watermark. The bug observed in
avail_geo.ts — where a "Latest · 7d" query returns one `/15m` segment
and stops at `authoritativeEnd = 2026-06-28T00:00Z` — is almost
certainly a ctbk-side wiring issue, not a pyrmts gap. This note
explains how to verify and where to fix.

(Authored after pyrmts session traced `mixed-tier-tail-coverage.md`
and found the feature already implemented; that spec was moved to
`pyrmts/specs/done/` with a resolution note.)

## What pyrmts already does

`js/packages/pyrmts/src/planner.ts` (in pyrmts repo), inside
`planQuery`:

```ts
for (let i = outputIdx; i >= 0; i--) {     // output tier DOWN to finest
  const tier = pyramid.tiers[i]!
  const entries = grid.byTier[tier.name]!  // canonical + partials, sorted by ascending effective
  for (const entry of entries) {
    ...
    segments.push({
      ...
      shardTier: tier,
      shardCadence: entry.cadence,
      reaggregate: i !== outputIdx,        // <-- finer tier ⇒ re-aggregate to outputBin
    })
    if (segEnd > cursor) cursor = segEnd
    if (cursor >= plannedTo) break
  }
  if (cursor >= plannedTo) break
}
```

Behavior:

- Picks output tier `T` via `pickTier(binBudget)`.
- Walks `T → T-1 → … → tiers[0]` (finest).
- Within each tier, walks `(canonical, partials)` entries sorted by
  ascending effective watermark.
- Emits a segment per entry whose effective extends past `cursor`.
- Finer-tier segments are marked `reaggregate: true`; the stitcher
  monoid-coarsens them up to `outputTier.bin` (here `/15m`).

So the expected plan for "Latest · 7d" today (assuming ctbk passes
all the right knobs) is:

```
{ tier: '/15m', cadence: null,  from: <now-7d>,     to: '06-28T00:00' }   // canonical
{ tier: '/1m',  cadence: '12h', from: '06-28T00:00', to: '06-28T12:00', reaggregate: true }
{ tier: '/1m',  cadence: '1h',  from: '06-28T12:00', to: '06-29T02:00', reaggregate: true }
{ tier: '/1m',  cadence: '5min',from: '06-29T02:00', to: '06-29T02:30', reaggregate: true }
```

(intervening `/5m`, `/2m` skip silently because their effective ≤
cursor).

Existing planner tests covering this exact shape:

- `planner.test.ts:1060` — `"fall-through to finer tier picks up after coarser tier's max effective"`
- `planner.test.ts:1097` — `"reaggregate=true for partial segments emitted by a finer tier"`
- `planner.test.ts:1147` — `"fully gates one entry; sibling entries in same tier emit normally; finer fall-through covers the gated tail"` (the per-cadence-earliest variant — exact shape of avail-v3's `/1m` gating with finer fall-through)

## Why ctbk sees only one segment today

`pyrmts.effectiveShardWatermarks` SKIPS missing partial-cadence
entries from the grid:

> ```
> // Default semantics differ for canonical vs partial:
> //   - canonical missing → FAR_FUTURE ("complete enough"; …)
> //   - partial missing → SKIPPED from the grid entirely. A declared-
> //     in-config cadence that hasn't been sealed yet shouldn't poison
> //     within-tier propagation …
> ```

So if avail_geo.ts is passing `watermarks = { '/15m': …, '/1m': … }`
with only canonical entries — no `'1m@5min' / '1m@1h' / '1m@12h'`
keys — then `/1m`'s grid for the planner has just one entry:
canonical effective ≈ `06-27T00:00` (the day before cron started).

Walk trace under that condition:

- `i = /15m`: emit canonical → cursor `06-28T00:00`.
- `i = /5m, /2m`: each has only canonical, effective ≤ cursor, no emit, no advance.
- `i = /1m`: canonical effective `06-27T00:00` < cursor `06-28T00:00`. segEnd < segStart → no emit. cursor unchanged.
- Loop ends; tail `[06-28T00:00, now]` uncovered.

That's exactly the symptom in the observed worker output.

## Things to check on ctbk side

1. **Pyrmts pin.** Is ctbk on a pyrmts dist branch SHA that includes
   both `partial-shards.md` and `per-cadence-earliest.md`? The
   feature's been in `main` since the partial-shards landing; the
   per-cadence-earliest landing was the most recent commit on
   `pyrmts` `main` (SHA `ccfeb33`, dist branch updated 2026-06-21).
   `pds gh pyrmts` (latest) should pull it.

2. **Partial-cadence watermarks emitted to `planGeoQuery`.** Look at
   how ctbk derives the `watermarks` arg to
   `serveGeoQuery({ pyramid, request, watermarks: … })`. It needs
   D1 entries for *every* `(tier, cadence)` pair, keyed using
   `pyrmts.encodeWatermarkKey(tier, cadence)` (returns `${tier}` for
   canonical, `${tier}@${cadence}` for partials). Example D1 query:

   ```sql
   SELECT
     tier,
     cadence,            -- '' for canonical, '5min'|'1h'|'12h'|... for partials
     MAX(period_start) + shard_duration_ms AS watermark
   FROM pyramid_shards
   WHERE pyramid = 'avail-v3'
   GROUP BY tier, cadence
   ```

   And ctbk encodes:

   ```ts
   const watermarks: Record<string, Date> = {}
   for (const { tier, cadence, watermark } of rows) {
     const key = cadence === '' ? tier : `${tier}@${cadence}`
     watermarks[key] = new Date(watermark)
   }
   ```

   If `watermarks` lacks the `'1m@5min'`-style keys, the planner has
   nothing to walk past the canonical fall-through.

3. **`earliestPerCadence` for the cron deploy date.** Also pass
   `earliestPerCadence: { '1m@5min': cronStart, '1m@1h': cronStart,
   '1m@12h': cronStart, '1m': cronStart }` (whatever the actual
   start-of-coverage is per cadence; usually the deploy date for the
   CFW cron). Without this, `/1m` partial entries SHOULD still emit
   (per-cadence-earliest only adds a *gate*; the walk works without
   it) — but adding it is forward-compat with the gating semantics
   when ctbk's hot-tail logic eventually needs to suppress data
   before cron deploy.

4. **avail_geo.ts:413 comment.** The pyrmts session flagged a comment
   around that line: *"walks `<picked tier>` only ... no fall-through
   to coarser indices"*. If avail_geo.ts has a wrapper loop around
   `planGeoQuery` that post-filters or re-segments, check whether
   that wrapper is dropping the finer-tier segments planQuery already
   emits. (Coarser fall-through IS out of scope per the pyrmts spec
   conclusion — only finer is supported; coarser tiers can't have
   data finer tiers' partials don't.)

5. **Pyramid declares partials.** ctbk's `avail-v3` pyramid config
   must declare `partials: ['5min', '1h', '12h', ...]` (matching
   actual ladder) and `partialKey: 'avail-v3/{tier}/p{shard}/{period}.parquet'`
   (or whatever the R2 layout is). Without `partials`, `validatePartials`
   leaves the grid canonical-only and partial-cadence watermark keys
   are ignored even if passed.

## What success looks like

After wiring 1-5 above, the worker response for "Latest · 7d" should
return ≥4 segments — one /15m canonical + the /1m partial cascade — and
`authoritativeEnd` should advance to the latest /1m partial's effective
(e.g. `06-29T02:30Z`), not stop at `06-28T00:00Z`.

If after wiring all of the above ctbk STILL sees one segment, drop
back to pyrmts with a `console.log(JSON.stringify({ watermarks,
earliestPerCadence }, null, 2))` of the args passed into `planQuery`,
and a snapshot of the returned `plan.segments`. There may be a
propagation bug specific to the avail-v3 ladder shape (8 tiers,
canonical-only on all coarser tiers, partials on /1m only) that the
existing planner tests (`{raw=1min, h1=1h}`) don't reproduce.

## Cross-reference

- pyrmts walk: `js/packages/pyrmts/src/planner.ts:186-223`
- pyrmts watermark grid: `js/packages/pyrmts/src/planner.ts:533-616`
- pyrmts watermark key encoding: `js/packages/pyrmts/src/shard-index.ts:encodeWatermarkKey`
- pyrmts spec (resolution): `pyrmts/specs/done/mixed-tier-tail-coverage.md`
- prior pyrmts specs: `partial-shards.md`, `per-cadence-earliest.md`
