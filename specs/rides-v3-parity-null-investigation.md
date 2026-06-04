# `rides-v3` parity gap — null lat/lng investigation

## Context

After wiring the v3 (S2-keyed) pyramid end-to-end with FE-side `minimalCover`
(mixed-resolution + subtraction), totals match the canonical `ymrgtb-cd`
ground truth within ~0.6 % across the three regions, but with a small
asymmetric residual:

| Region | GT          | v3          | Δ     | % off    |
| ------ | ----------- | ----------- | ----- | -------- |
| NYC    | 4,767,656   | 4,767,667   | +11   | +0.0002 % |
| JC     | 60,013      | 60,312      | +12 / +299 ? | +0.5 % |
| HOB    | 50,712      | 50,399      | −313  | −0.6 %   |

(2026-04 month, anchor=start.)

The cover is exact w.r.t. the station set used for it (≈2340 active
stations from `stations-regional.json`), so the mixed-resolution geometry
isn't the issue. Suspect: rides with **null start lat/lng** that the
build's per-station-id fallback (`build_1h_month_table`) couldn't resolve.
Those rides:

- Get **dropped** from the pyramid (line ~398 in `ctbk/rides_v1.py`:
  `df.dropna(subset=[lat_col, lng_col])`).
- Are still counted in `ymrgtb-cd` because that aggregation uses the
  consolidated parquets' explicit `Region` column, not lat/lng.

If true, this fully explains the asymmetry: drops show up as v3-under for
the affected region. NYC matches because nearly all its rides have valid
lat/lng (and the +11 is noise); JC/HOB take small hits because their
lower volume amplifies the same loss-rate.

(`+299 JC` doesn't quite match the summary's `+12` — leaving both
possibilities open; the verification will resolve it.)

## Goal

Confirm or refute: **the v3 vs GT gap = rides dropped in v3 for null
lat/lng (after station-id fallback) attributable to that region**.

## Where this needs to run

Locally would need pulling consolidated parquets (large). Run on `e`,
which already has the full pipeline data.

## Steps

1. **Re-run a build month with logging captured.** The current
   `build_1h_month_table` already prints
   `dropped <n> rides still missing lat/lng after fallback`. Pick one
   recent month (e.g. `202604`) and capture stderr from `ctbk build-1h`
   (or whatever the entrypoint is — see `Variant += 'v3'` flow). Note
   the per-`(ym, anchor)` drop counts.

2. **Count dropped-and-Region-tagged rides directly from consolidated
   parquet.** For the same month:

    ```python
    import pandas as pd
    df = pd.read_parquet('s3://ctbk/normalized/202604.parquet')  # or local mirror
    drops = df[df['Start Station Latitude'].isna() | df['Start Station Longitude'].isna()]
    by_region = drops.groupby('Region').size()
    print(by_region)
    ```

    This gives the per-region count of rides that v3 **could** drop
    (subset of these get rescued by station-obs fallback, so it's an
    upper bound).

3. **Subtract the rescued count.** From step 1's stderr, the
   `filled <m>/<n> null lat/lng from station-observations` lines give
   rescue rates. Rescued rides have correct lat/lng → get cell-ified →
   show up in v3. Dropped = rides where fallback failed
   (no station-obs history for that station_id, or station_id itself
   null).

4. **Region-attribute the drops.** The drops still have a `Region`
   column in the consolidated parquet (canonical region, not derived
   from lat/lng) — group those by region. Compare to the observed v3-vs-GT
   deltas.

5. **Verdict.** If `(GT − v3)` per region ≈ `(unrescued nulls per
   region)`, hypothesis confirmed. If the numbers don't match — look
   for other build-time losses (e.g. invalid `Bike ID`, `Birth Year`
   filters, region-coercion of unknown station_ids).

## Out of scope

- Actually fixing the gap. If confirmed, the fix is in build (also
  store rides with null lat/lng under a synthetic sentinel cell, or
  emit a separate "region-only" parquet that v3 unions in). For now
  we accept the ~0.6 % delta and document it.

- Other months. If 202604 matches the hypothesis cleanly we're done;
  if not, look at 2-3 historical months for the residual pattern.

## Deliverable

Short comment on this spec with the verification numbers + verdict.
Spec moves to `specs/done/` either way.
