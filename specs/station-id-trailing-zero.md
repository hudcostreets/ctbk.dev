# Station-id corruption in `cons` + harmonize guard fixes

Status: code fixed on `merge-review` (2026-09-26); **data regen + prod rides rebuild not yet run** (ops sequence below).

Found via `/merge-review` (rides-rekey P5): `c:4452.01` "Lafayette Ave & Classon Ave" absorbed Journal Square (JC, 10 km away) through raw id `3640`.

## Root cause: `cons` appends `0` to integer station ids

`ctbk/consolidated.py` (from `eb541940`, 2025-07-13, "fix missing trailing 0s in station IDs") re-padded any id `i` whose `i + '0'` also appeared in the month. The target was float-mangled decimal ids (`5329.1` → `5329.10`), but it matched integer ids too: `309` "Murray St & West St" became `3090`, merging it with the real `3090` "N 8 St & Driggs Ave" (Williamsburg).

- The raw Citi Bike CSV (2018-01) says `309`/`364`, and the `norm` output (`normalized/201801/`) is still correct. Only `cons` output (`normalized/YYYYMM.parquet`, the public dataset and the rides pyramids' source) is corrupted.
- Scope: **74 integer id pairs `N` → `N0`**, ~10.6M station visits (starts + ends) misattributed, in **59 months**: `201306`, `201507`–`201912`, `202006`–`202008`, `202010`. Ride totals are unaffected; only station attribution is wrong.
- All 37 `/merge-review` clusters with members >1 km apart are this bug (e.g. `3640` → `c:4452.01`, `3370` "E 78 St & 2 Ave" → `c:4993.13` FiDi, `3220` "5 Corners Library" (JC) → `c:4748.07` Clinton St & Tillary). None is an independent harmonize false merge.

Fix: `truncated_decimal_ids` only re-pads single-decimal ids (`\d+\.\d`); tested (`ctbk/tests/test_truncated_decimal_ids.py`).

## Harmonize co-activity guard (`ctbk/stations/harmonize.py`)

Three guard fixes, each tested in `ctbk/tests/test_harmonize_coactivity.py`; the first three tests below fail on the old code:

1. **Live groups.** The guard compared only the two ids (pass 1) or a pre-pass snapshot of components (pass 2); unions are transitive, so `5947.06` "E 15 St & 5 Ave" reached `6022.04` "E 16 St & 5 Ave" (both busy since 2024-07) through the 58-ride `6022.04_Pillar`. It now compares every id already unioned into each side.
2. **Same dock.** Pairs with the same normalized name ≤ 30 m apart (`SAME_DOCK_M`), and `_` variants, don't count as co-active: an extra dock bank or a relocation hand-off overlaps its twin (`6960.10`/`6960.12` "3 Ave & E 71 St", `7727.07`/`7727.08`, `5506.10`/`5575.12`, `5303.06`/`5303.06_`).
3. **Strongest match first.** Pass-2 candidates are applied by name similarity, then distance. With a live-group guard, order decides conflicts: `3091` "Frost St & Meeker St" (predecessor of `5371.07` "Frost St & Meeker Ave") must join before `3089` "Leonard St & Meeker Ave", which was co-active with it.

## GBFS relabels in `station-luc.json` (`ctbk/station_luc.py`)

`merge_relabeled`: a short_name whose GBFS UUID now carries a newer short_name is its former label, not a second live station (`5685.04` → `5685.06`, one UUID, docks moved ~20 m). It goes into the `merged` overlay alongside same-dock merges. Tested in `ctbk/tests/test_station_luc_relabel.py`.

## Preview: id-map after the fixes

This is harmonize with the fixed guard over meta_hists un-corrupted in place: names and positions were intact, so rows were moved back to `N` by name and location. The committed id-map reproduces byte-for-byte from the current meta_hists with the old code, so the diff below is the fixes alone. 72 ids change: 66 are the `N0` ids resolving to their real stations (e.g. `3640` → `JC103` Journal Square, `3090` → its own, `3370` → `7057.07`; `364` stays in `c:4452.01`). The other 6:

| id | before → after | call |
|---|---|---|
| `5947.06` E 15 St & 5 Ave | `6022.04` → own | split: concurrently busy a block from E 16 St since 2024-07 |
| `6474.12` E 41 St & Madison (SW corner), `3235` | `6432.10` → `6474.12` | split: SW vs SE corner, co-active 2021-10..2023-01; `3235` (2015–19) sits exactly at the SW position |
| `3089` Leonard St & Meeker Ave | `5371.07` → own | split: co-active with `3091` (Frost St) for 12 months, 60 m away |
| `3104` Kent Ave & N 7 St | own → `5489.03` | **ambiguous** (below) |
| `233` Joralemon St & Adams St | own → `4637.06` | **ambiguous** (below) |

Kept as merged (checked): `5303.06`/`5303.06_` (same name, ~15 m apart: a second dock bank), and the same-dock hand-offs above.

### For the owner

- **`3104` → `5489.03` "Kent Ave & N 7 St".** It is 15 m from `3016`, with the same name. They were co-active for 2 months, one of them while `3016` reported as "Mobile 01". The 09-13 regen deliberately split it; the same-dock rule now re-merges it. Lean: merge (one dock).
- **`233` → `4637.06` "Fulton St & Adams St".** "Joralemon St & Adams St" ended 2016-06, and Fulton St & Adams opened 70 m away 5 months later. That reads like a relocation, but the street differs. Lean: keep separate; that needs a manual exclusion, since the fuzzy pass now merges it.

## Ops sequence (not run)

Order matters: each step's inputs come from the previous one. Heavy steps run on `e`. Cloud writes are marked ☁.

1. **Regenerate `cons` for the 59 months** (on `e`; reads the correct `norm` dirs from the DVX cache):
   `ctbk cons create -w0 201306 201507-201912 202006-202008 202010` → commit the `.parquet.dvc` files → ☁ `dvx push -r r2`. About 1.2 GB written (old blobs stay in the content-addressed cache). This also fixes the public `data.ctbk.dev/normalized/` dataset.
2. **Per-month derived stages** for the same months: `ctbk smh create -gil …`, `ctbk smh create -gin …`, and the station-keyed aggregates `ctbk agg create -gse -ac …`, `-g ymrgtbs -acd …`, `-g ymrgtbe -acd …` (region-level aggregates are unaffected). Then `ctbk sm create`, `ctbk spj create` → ☁ `dvx push -r r2`.
3. **`ctbk station-harmonize create -f`** on `e`. `-f` is required, because cached observations for the 59 months are corrupted. It needs every consolidated month locally (~5–8 GB). Check the id-map diff against the preview above; expect ~72 changes plus the owner's calls on `3104`/`233`.
4. **`ctbk station-luc-build -R`** (local only, no upload) → review the `moved`/`new` LUC churn. New historical canonicals (`3090`, `JC103`, …) and dropping `5685.04` can move neighbors' LUCs, which matters for avail serving. Then ☁ upload (`ctbk station-luc-build`, no `-R`).
5. **Rides assets:** `ctbk rides-canonicalize-map -u` (☁ writes `stations/station-canonicalize-map.json` + `rides-extra-stations.json`), then `ctbk rides-merge-review` (regenerates `www/public/assets/station-merges.json`), and regenerate `gbfs/engine/station-geo.json` via `rides_assets.regen_geo_json` (inputs are the new `station-observations.parquet`).
6. **Engine image:** commit the new `station-id-map.json`/`station-geo.json` → ☁ `pyrmts-engine batch push -c . -f gbfs/engine/Dockerfile -p linux/arm64 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-engine:<sha>` → ☁ `ctbk gbfs engine jobdef -s <image>`.
7. ☁ **`ctbk gbfs normalized-mirror`** for the 59 months (R2 server-side copies to the plain `normalized/` keys the rides factory lists).
8. **Rebuild both rides pyramids over full history.** Raw `s:` leaves change for 2013–2020, and id-map changes move rides between S2 cells as late as 2026 (`5947.06`, `6474.12`), so a `c:`-only canonicalize pass isn't enough:
   ```
   for a in start end; do
     ctbk gbfs invalidate -C rides-$a 2013-06-01T00:00:00Z <now>                                  # ☁ journal
     .github/scripts/hccs-aws.sh ctbk gbfs engine submit -C rides-$a -R -f -W                    # ☁ Batch fill honors the journal
     ctbk gbfs engine canonicalize -C rides-$a -j 4                                               # ☁ full range: map changed
     ctbk gbfs engine register <rides/$a manifest>                                                # ☁ D1 pyramid_shards
   done
   ctbk gbfs manifest backfill -p rides-start -p rides-end                                        # ☁ D1 rg_manifest
   ctbk gbfs manifest prune -p rides-start -p rides-end                                           # ☁ D1 orphan RG rows
   ```
   Content-hashed keys mean new objects land at new keys and D1 switches over on register, so there's no in-place rewrite and no `lambda reconcile` needed.
9. **Validate:** `ctbk gbfs rides-totals-diff` should match exactly, since only attribution changes. `ctbk gbfs rides-rekey-check`. `/merge-review`: the 37 far clusters should be gone and `c:` should equal Σ members.
10. **Edge cache:** closed-period `/api/rides*` responses are cached `immutable` for 24h on the workers.dev worker (no zone purge available); wait it out or bump a cache-busting param in the FE.

### Size / cost

- **Batch:** a full rides rebuild was ~20 min per anchor on the 16-vCPU Fargate Spot CE (267 shards / 14.5 GB per anchor). Under $1.
- **R2:** ~29 GB of new rides objects; superseded keys stay until purged (~+$0.45/mo meanwhile). Plus ~1.2 GB of new `cons` blobs. Class A ops are in the thousands, inside the free tier.
- **D1:** register ~534 rows. RG-manifest backfill ~0.7M rows plus prune ~0.7M deletes ≈ 2.8M row-writes with the index, against 50M included this cycle (7.3M used), so $0. Size peaks at ~+0.7 GB (4.0 → ~4.7 of 10 GB) until the prune.
- **`e`:** a few hours for `cons`/`smh`/`agg` over 59 months plus a full harmonize.
