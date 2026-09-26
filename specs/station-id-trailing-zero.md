# Station-id corruption in `cons` + harmonize guard fixes

Status (2026-09-26): code fixed and merged. Steps 1–3 of the ops sequence ran on HCCS Batch (`specs/batch-pipeline.md`): 59-month `cons` + derived stages, `ymrgtb{s,e}_cd`, and a harmonize matching the preview (71 id-map changes), all on branch `trailing-zero-repair` (unmerged). The prod rollout follows **Candidate rollout** below, not ops-sequence steps 4–10 in place.

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

This is harmonize with the fixed guard over meta_hists un-corrupted in place: names and positions were intact, so rows were moved back to `N` by name and location. The committed id-map reproduces byte-for-byte from the current meta_hists with the old code, so the diff below is the fixes alone. With the decisions applied, 71 ids change: 66 are the `N0` ids resolving to their real stations (e.g. `3640` → `JC103` Journal Square, `3090` → its own, `3370` → `7057.07`; `364` stays in `c:4452.01`). The rest (`233` is listed because it would otherwise change):

| id | before → after | call |
|---|---|---|
| `5947.06` E 15 St & 5 Ave | `6022.04` → own | split: concurrently busy a block from E 16 St since 2024-07 |
| `6474.12` E 41 St & Madison (SW corner), `3235` | `6432.10` → `6474.12` | split: SW vs SE corner, co-active 2021-10..2023-01; `3235` (2015–19) sits exactly at the SW position |
| `3089` Leonard St & Meeker Ave | `5371.07` → own | split: co-active with `3091` (Frost St) for 12 months, 60 m away |
| `3104` Kent Ave & N 7 St | own → `5489.03` | merge (owner decision, with `3016`) |
| `233` Joralemon St & Adams St | stays own | split (owner decision; the fuzzy pass alone would merge it) |

Kept as merged (checked): `5303.06`/`5303.06_` (same name, ~15 m apart: a second dock bank), and the same-dock hand-offs above.

## Reviewed decisions: `s3/ctbk/stations/station-merge-decisions.yaml`

One committed file is the source of truth for both harmonize and `/merge-review`. Each entry has `ids`, a `verdict`, a `kind` (`manual` / `guard` / `same-dock`), the date decided, and a one-line rationale:

- `merge`: harmonize unions the ids up front, and they don't count as co-active against each other, so the guard can't undo it.
- `split`: no union may put any two of them in one group, even transitively.
- `relabel`: shown on the page only; `station-luc-build`'s UUID collapse enforces it.

A merge that conflicts with a split raises an error. Tested in `test_decisions_override_heuristics` and `test_conflicting_decisions_raise`.

The 10 decisions so far:
- **Owner calls (2026-09-26):** `3016`/`3104`/`5489.03` merge; `233`/`4637.06` split.
- **Guard fixes:** `5947.06`/`6022.04`, `6474.12`/`6432.10`, `3089`/`3091` split.
- **Same dock:** `5303.06`/`5303.06_`, `6960.10`/`6960.12`, `7727.07`/`7727.08`, `5506.10`/`5575.12` merge.
- **Relabel:** `5685.04` → `5685.06`.

The page's **Decisions** view (`/merge-review?v=decisions`) lists each decision with the ids' eras, distances and live per-id series side by side, split pairs included. It also lists the 74 trailing-zero **id repairs** from `station-trailing-zero-repairs.json`, with before/after attribution and series; cross-region repairs come first.

## Regional impact of the trailing-zero bug

`ctbk station-harmonize trailing-zero-audit` detects the pairs from the station meta_hists, un-corrupts them, re-runs the id-map (with decisions), and writes `station-trailing-zero-repairs.json`. It must run **before** the `cons` regen, while the meta_hists still show the corruption.

The **public dataset and region aggregates** (`ymrgtb`, `Start/End Region`) are unaffected: `Region` is computed in `norm`, before `cons` rewrote the ids. The damage is in the **rides pyramid**, which draws every ride at its station's canonical location. So what matters is the canonical the old id-map gave each `N0`.

- **Direction:** in 66 of 74 pairs both stations are NYC (attribution moved within NYC). In 7 pairs a **JC** station's rides were drawn at an **NYC** canonical. Nothing moved into JC and HOB is unaffected, so the bug **deflated JC; it did not inflate it.**
- **Magnitude:** about **91k JC rides** (182.5k station visits, starts + ends) drawn in NYC, 2015-09 → 2021-01. That's 3–7.5% of JC's rides every month (peak 7.5% in 2019-01). A steady undercount, not zeroed months.

| year | JC rides (region aggregate) | drawn in NYC instead | share |
|---|---|---|---|
| 2015 (Sep–Dec) | 52,876 | 1,737 | 3.3% |
| 2016 | 247,205 | 10,243 | 4.1% |
| 2017 | 294,817 | 14,734 | 5.0% |
| 2018 | 353,891 | 21,983 | 6.2% |
| 2019 | 404,944 | 25,935 | 6.4% |
| 2020 | 323,352 | 15,933 | 4.9% |
| 2021 (Jan) | 11,627 | 690 | 5.9% |

Per affected JC station, 100% of its rides over the span were drawn at the NYC canonical ("~rides" ≈ visits / 2):

| station | correct placement | drawn at | span | visits | ~rides |
|---|---|---|---|---|---|
| `3270` Jersey & 6th St | JC (`JC027`) | `c:5297.02` Vesey Pl (NYC) | 2016-07 → 2021-01 | 59,270 | ~29,635 |
| `3210` Pershing Field | JC (`JC024`) | `c:4821.06` Cadman Plaza E (NYC) | 2015-09 → 2021-01 | 38,132 | ~19,066 |
| `3640` Journal Square | JC (`JC103`) | `c:4452.01` Lafayette & Classon (NYC) | 2017-10 → 2021-01 | 32,466 | ~16,233 |
| `3280` Astor Place | JC (`JC077`) | `c:5578.02` Watts St (NYC) | 2016-10 → 2021-01 | 25,291 | ~12,645 |
| `3220` 5 Corners Library | JC (`JC018`) | `c:4748.07` Clinton & Tillary (NYC) | 2015-09 → 2021-01 | 21,571 | ~10,785 |
| `3190` Garfield Ave Station | JC | `c:5175.08` (NYC) | 2015-09 → 2018-04 | 4,714 | ~2,357 |
| `3200` MLK Light Rail | JC | `c:5359.11` (NYC) | 2015-09 → 2018-04 | 1,101 | ~550 |

The biggest NYC-internal repairs move 100k–470k visits between Manhattan and Brooklyn/Queens stations, e.g. `327` Vesey Pl, `3260`/`326`, `305` E 58 St → `3050` Putnam Ave. They're listed on the page.

## Ops sequence (not run)

Order matters: each step's inputs come from the previous one. Heavy steps run on `e`. Cloud writes are marked ☁.

1. **Regenerate `cons` for the 59 months** (on `e`; reads the correct `norm` dirs from the DVX cache):
   `ctbk cons create -w0 201306 201507-201912 202006-202008 202010` → commit the `.parquet.dvc` files → ☁ `dvx push -r r2`. About 1.2 GB written (old blobs stay in the content-addressed cache). This also fixes the public `data.ctbk.dev/normalized/` dataset.
2. **Per-month derived stages** for the same months: `ctbk smh create -gil …`, `ctbk smh create -gin …`, and the station-keyed aggregates `ctbk agg create -gse -ac …`, `-g ymrgtbs -acd …`, `-g ymrgtbe -acd …` (region-level aggregates are unaffected). Then `ctbk sm create`, `ctbk spj create` → ☁ `dvx push -r r2`.
0. **Before anything else:** `ctbk station-harmonize trailing-zero-audit` (local; needs the current, corrupted meta_hists), then commit `station-trailing-zero-repairs.json`. Already done on `merge-review`.
3. **`ctbk station-harmonize create -f`** on `e`. It enforces `station-merge-decisions.yaml`. `-f` is required, because cached observations for the 59 months are corrupted. It needs every consolidated month locally (~5–8 GB). Check the id-map diff against the preview above; expect 71 changes (the owner's calls on `3104`/`233` included).
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

## Candidate rollout

Steps 4–10 above would write the repair straight into what prod serves: `station-luc.json`, `stations/station-canonicalize-map.json`, `normalized/` and the `rides-{start,end}` registry are all fixed-key inputs. Instead, write every changed input **beside** the live one, point the dev worker at it, validate, then cut prod over, with the old inputs kept for rollback until GC.

| Input | Live (prod reads) | Candidate (dev reads) | Cutover |
|---|---|---|---|
| Station registry | `station-luc.json` (also read by the avail cascade Lambda + smg fill) | `station-luc.<md5[:12]>.json` via `STATION_LUC_KEY` | copy onto `station-luc.json` |
| Rides id-map + vocab supplement | `stations/station-canonicalize-map.json`, `stations/rides-extra-stations.json` | content-addressed keys via `CANON_MAP_KEY` / `EXTRA_STATIONS_KEY` | copy onto the live keys |
| Monthly tiles (+ public dataset) | `normalized/<YM>.parquet` | `normalized-next/<YM>.parquet` (all months), read by the candidate build via `CTBK_NORMALIZED_PREFIX` | `normalized-mirror` (copies only months whose bytes differ) |
| Rides shards | content-hashed keys under `rides/{start,end}/`, `manifest.jsonl`, D1 `rides-{start,end}` | same prefixes (new keys beside old), `manifest-next.jsonl`, D1 `rides-next-{start,end}` via `RIDES_PYRAMID` | `engine register` the candidate manifest under the prod names; it becomes `manifest.jsonl` |
| Engine image (baked id-map + geo) | latest `pyrmts-engine` job-def revision | a revision registered only for the candidate builds, then reverted | re-register the candidate image |

Serve-side switches: `gbfs/api/src/serve_config.ts` (`RIDES_PYRAMID`, `STATION_LUC_KEY`, `CANON_MAP_KEY`, `EXTRA_STATIONS_KEY`; defaults = prod) and `RIDES_CACHE_GEN` (folded into the `/api/rides*` edge-cache key). Engine: `CTBK_NORMALIZED_PREFIX`, `CTBK_STATION_LUC_KEY` (`gbfs/engine/ctbk_engine_src.py`).

Conventions below: `A=2363642879f18d37d52dca114059937e` (HCCS CF account, not secret); R2 writes use `R2_RW_*`; AWS commands run with `AWS_PROFILE=h`; D1 registry/manifest writes go through the prod worker's registry proxy (`CTBK_REGISTRY_SECRET`), as `rides-extend` does. ☁ marks cloud writes; everything before **Cutover** leaves prod serving unchanged.

### 1. Candidate assets (from `wt/repair`, after merging `main` into `trailing-zero-repair` for this tooling)

Prereq: this tooling (`repair-cutover`) on `main`. Its api changes are prod-neutral except one fix: og images now read `station-luc.json` (they read a stale `gbfs/station-luc.json` copy from 2026-09-11).

```
ctbk station-luc-build -c                         # ☁ station-luc.<h>.json only; prints the key → $LUC_KEY
                                                  #   also rewrites www/public/assets/station-luc.json (the FE copy)
ctbk rides-canonicalize-map -u -c                 # ☁ prints CANON_MAP_KEY=… EXTRA_STATIONS_KEY=… (reads the new local luc's `merged` overlay)
ctbk rides-merge-review                           # www/public/assets/station-merges.json (/merge-review input)
python -c 'from ctbk.pyramid_cascade.rides_assets import regen_geo_json as g; g()'   # gbfs/engine/station-geo.json
git add -u && git commit -m 'repair: candidate station assets' && git push h trailing-zero-repair
```

**Review** `station-luc-build`'s `LUC churn: N stations moved, M new` line. Moved stations' historical **avail** rows (`avail-v6`, `smg-v1`) are keyed under their old cell; incremental fills won't re-key them. If `N > 0`, decide before cutover whether to journal the WAL era for the avail pyramids (`ctbk gbfs invalidate -C avail-v6 2026-04-07T00:00:00Z <now>`, same for smg-v1), which is a large refold, or accept the drift for those stations.

### 2. Candidate rides build

```
# engine image with the repaired id-map + geo baked in (the ctbk-engine flow; base image unchanged)
pyrmts-engine batch push -c . -f gbfs/engine/Dockerfile -p linux/arm64 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-engine:<sha>   # ☁ ECR
ctbk gbfs engine jobdef -n x                      # prints the live revision's image → $LIVE_IMAGE (record it)
ctbk gbfs engine jobdef 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-engine:<sha>                                                      # ☁ new revision

ctbk gbfs normalized-mirror -d normalized-next    # ☁ all 159 months (the build lists this prefix), ~12.4 GB server-side copies
ctbk gbfs engine gaps -C rides-start -m manifest-next.jsonl | wc -l     # every slot (fresh manifest ⇒ full build)

for a in start end; do                             # in parallel, ~20 min each
  ctbk gbfs engine submit -C rides-$a -R -f -I -m manifest-next.jsonl \
    -e CTBK_NORMALIZED_PREFIX=normalized-next -e CTBK_STATION_LUC_KEY=$LUC_KEY -W &                                                         # ☁ Batch; new keys + manifest-next.jsonl
done
# as soon as both jobs are RUNNING (a job keeps its submit-time revision): put prod back on the live image,
# so `rides-extend` (monthly CI) never builds with the candidate id-map before cutover
ctbk gbfs engine jobdef $LIVE_IMAGE                                                                                                          # ☁ new revision
for j in $(jobs -p); do wait $j || echo "build $j FAILED"; done
```

`-I` matters: `-f` otherwise consumes and prunes `rides/<a>/_invalidations.json`, the **live** build's pending repairs. The candidate build registers nothing live: its records land in `manifest-next.jsonl` only.

Canonicalize the candidate manifests over the full range (the id-map changed), on the reproc Batch queue: `-b` checks out the repair branch's `s3/`, so `-m` reads the repaired map.

```
ctbk regen -w -b trailing-zero-repair -n canon-next -s "export CLOUDFLARE_ACCOUNT_ID=$A; \
  ctbk gbfs engine canonicalize -C rides-start -i manifest-next.jsonl -m s3/ctbk/stations/station-canonicalize-map.json -j 8 & s=\$!; \
  ctbk gbfs engine canonicalize -C rides-end   -i manifest-next.jsonl -m s3/ctbk/stations/station-canonicalize-map.json -j 8 & e=\$!; \
  wait \$s && wait \$e"                                                                                                                     # ☁ new keys, appended to manifest-next.jsonl

for a in start end; do
  ctbk gbfs engine register -P rides-next-$a s3://ctbk/rides/$a/manifest-next.jsonl                                                          # ☁ D1 ~267 rows each
  ctbk gbfs engine slot-compare -C rides-$a manifest.jsonl manifest-next.jsonl | tail -3                                                     # informational: how many slots changed
done
ctbk gbfs manifest backfill -p rides-next-start -p rides-next-end                                                                            # ☁ D1 RG manifest
```

### 3. Dev worker on the candidate

```
cd gbfs/api && CLOUDFLARE_API_TOKEN=$CF_PULUMI_HCCS_TOKEN CLOUDFLARE_ACCOUNT_ID=$A pnpm exec wrangler deploy --env dev \
  --var RIDES_PYRAMID:rides-next --var STATION_LUC_KEY:$LUC_KEY \
  --var CANON_MAP_KEY:$CANON_MAP_KEY --var EXTRA_STATIONS_KEY:$EXTRA_STATIONS_KEY                                                             # ☁ dev worker only
```

The GHA deploy doesn't touch the dev worker, so these vars persist until the next manual `--env dev` deploy.

### 4. Validate (dev = candidate, prod = live)

```
ctbk gbfs rides-totals-diff -c rides-next -C rides                                     # exact per year, both anchors (attribution-only repair)
ctbk gbfs rides-rekey-check -L $LUC_KEY -M $CANON_MAP_KEY -x s3/ctbk/stations/station-trailing-zero-repairs.json
                                                                                        # no ✗; repaired stations show `~ expected`, pairs print split totals
ctbk gbfs api-check -e dev                                                             # goldens sit outside the repaired windows: expect 11/11
```

Then in a browser (HCCSx profile), from `wt/repair`: `cd www && VITE_API_BASE=https://ctbk-gbfs-api-dev.hccs-ctbk.workers.dev pnpm dev`:

- `/merge-review`: the 37 clusters with members > 1 km apart are gone; the Decisions view's repairs show before/after split.
- `/s/lafayette+classon` (`4452.01`) and Journal Square (`JC103`): separate series for 2017-10 → 2021-01.
- Homepage on prod with `?api=dev`: region charts equal prod (region columns were never wrong).

### 5. Cutover

```
for a in start end; do
  ctbk gbfs r2 cp rides/$a/manifest.jsonl rides/$a/manifest-pre-repair.jsonl                                                                 # ☁ rollback copy
  ctbk gbfs engine register -P rides-$a s3://ctbk/rides/$a/manifest-next.jsonl                                                               # ☁ D1: prod serves the candidate
  ctbk gbfs r2 cp -f rides/$a/manifest-next.jsonl rides/$a/manifest.jsonl                                                                    # ☁ monthly `rides-extend` builds on it
done
ctbk gbfs manifest backfill -p rides-start -p rides-end                                                                                       # ☁ RG rows are per (pyramid, key)
for k in station-luc.json stations/station-canonicalize-map.json stations/rides-extra-stations.json; do
  ctbk gbfs r2 cp $k ${k%.json}.pre-repair.json                                                                                               # ☁ rollback copies
done
ctbk gbfs r2 cp -f $LUC_KEY station-luc.json                                                                                                  # ☁ API, avail Lambda, smg fill now read it
ctbk gbfs r2 cp -f $CANON_MAP_KEY stations/station-canonicalize-map.json
ctbk gbfs r2 cp -f $EXTRA_STATIONS_KEY stations/rides-extra-stations.json
ctbk gbfs normalized-mirror                                                                                                                  # ☁ from wt/repair: only the 59 changed months copy (public dataset fixed)
ctbk gbfs engine jobdef 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-engine:<sha>                                                      # ☁ monthly builds use the repaired id-map
```

Then merge `trailing-zero-repair` into `main` with `RIDES_CACHE_GEN = "trailing-zero-repair"` added under `[vars]` in `gbfs/api/wrangler.toml` (the push deploys the api worker, rotating its cached rides responses, and www with the new `station-luc.json` / `station-merges.json`), run `ctbk gbfs api-check -u` if any golden moved and commit the diff, and redeploy the dev worker without the `--var`s. Browsers that already hold a past-window response keep it until its 24h `immutable` expiry; nothing server-side can reach those.

**Rollback** (until GC): `engine register -P rides-$a s3://ctbk/rides/$a/manifest-pre-repair.jsonl`, `r2 cp -f` the `manifest-pre-repair.jsonl` and `*.pre-repair.json` copies back, `engine jobdef $LIVE_IMAGE`, `normalized-mirror` from a `main` checkout from before the merge, revert the merge, and bump `RIDES_CACHE_GEN` again.

### 6. GC (after a week or so of clean `api-check` runs)

```
ctbk gbfs d1 drop -y -p rides-next-start -p rides-next-end                                                                                    # ☁ D1
ctbk gbfs manifest prune -p rides-start -p rides-end -p rides-next-start -p rides-next-end                                                   # ☁ D1 orphan RG rows
for a in start end; do
  pyrmts-engine gc -i d1://845e34bb-d138-4076-9955-5909e30d4323 -n rides-$a configs/pyramids/rides-$a.yaml                                     # dry run: superseded keys
  pyrmts-engine gc --apply -i d1://845e34bb-d138-4076-9955-5909e30d4323 -n rides-$a configs/pyramids/rides-$a.yaml                             # ☁ (AWS_ENDPOINT_URL=https://$A.r2.cloudflarestorage.com)
  ctbk gbfs r2 rm rides/$a/manifest-pre-repair.jsonl rides/$a/manifest-next.jsonl                                                             # ☁
done
ctbk gbfs r2 rm -p normalized-next/                                                                                                            # ☁
ctbk gbfs r2 rm $LUC_KEY $CANON_MAP_KEY $EXTRA_STATIONS_KEY station-luc.pre-repair.json \
  stations/station-canonicalize-map.pre-repair.json stations/rides-extra-stations.pre-repair.json                                            # ☁
```

### Candidate rollout cost

- **R2:** `normalized-next/` ~12.4 GB and the candidate rides keys ~29 GB (fewer where a slot's bytes didn't change) until GC, ~$0.65/mo meanwhile. Class A ops (~160 mirror copies + ~1.1k shard writes) inside the free tier.
- **Batch:** two rides builds (~20 min each) + one canonicalize job, under $1.5.
- **D1:** candidate register ~534 rows + backfill ~0.7M; cutover register ~534 + backfill ~0.7M; GC drop ~534 + prune ~1.4M deletes. ≈ 6M row-writes with indexes, inside the 50M included ($0). Size peaks ~+1.4 GB (4.0 → ~5.4 of 10 GB; the `d1-size` alert fires at 8) until the prune.
