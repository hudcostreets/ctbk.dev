# De-version clean slate: `avail` / `rides` / `smg`

**Goal:** purge *all* version suffixes from the pyramid data model — names,
endpoints, R2 prefixes, D1 rows, configs, FE, CLI, docs — so the project reads
as if the current SOTA were one-shotted. The digits (`avail-v2…v6`, `rides-v3`,
`rides-v5`, `smg-v1`) count *failed development attempts*, not information worth
carrying. Current SOTA is the real "v1"; drop the number entirely.

Explicit owner decisions (2026-09-11):
- **Rename the endpoints too** (`/api/avail-v3` → `/api/avail`, etc.). The
  name↔version decoupling was defended as letting server-side pyramid cutovers
  skip FE churn — but this is a solo, unpublicized surface: coordinated FE+API
  deploys are cheap, no external consumers hold `/api/*` URLs, and the caches
  are cold enough that now is the moment to defrag. Keep the *pin mechanism*
  (`DEFAULT_PYRAMID` + `?pyramid=`) as a dormant capability; drop the
  version-named flag options.
- **"Forest fire":** err toward clearing cruft. Delete superseded R2 data and
  registry rows; leave no `-vN` strings behind.
- **Post-cutover, one dedicated pass.** Destructive + wide surface → keep it out
  of the RAC→HCCS flag-day. Runs on the survivor account (HCCS) once cutover is
  done.

## Target names (survivor ← current SOTA)

| kind            | current                     | → clean      |
|-----------------|-----------------------------|--------------|
| avail pyramid   | `avail-v6`                  | `avail`      |
| avail R2 prefix | `avail-v6/`                 | `avail/`     |
| avail endpoint  | `/api/avail-v3`             | `/api/avail` |
| rides pyramid   | `rides-v5-start`/`-end`     | `rides-start`/`-end` (or `rides/start`,`rides/end`) |
| rides R2 prefix | `rides-v5/`                 | `rides/`     |
| rides endpoint  | `/api/rides-v5`, `/api/rides-v3` | `/api/rides` |
| smg pyramid     | `smg-v1`                    | `smg`        |
| smg R2 prefix   | `smg-v1/`                   | `smg/`       |
| smg config      | `configs/pyramids/smg-v1.yaml` | `configs/pyramids/smg.yaml` |

Worker names (`ctbk-gbfs-*`) and the D1 (`ctbk-gbfs`) carry no version → leave.

## Collisions (must purge-before-claim)
- Registry name `avail` is **already the avail-v3 pyramid**; R2 has both `avail/`
  and `avail-v3/`. Delete the old `avail`/`avail-v3` (data + rows) *first*, then
  rename `avail-v6` → `avail` and re-key its shards to `avail/`.
- Verify `rides` prefix/name is free before claiming it.

## Purge list (superseded — delete on the survivor; retire with RAC)
`avail-v2`, `avail-v3`, `avail-v4`, `avail-v5`, `avail-v3-*` experiment
prefixes, `avail-geo`(?), `rides-v3`, plus the `avail-v3`/`avail-v5` copies
made to HCCS during migration (unnecessary — only `avail-v6` is the survivor).
Enumerate authoritatively from `pyramid_shards` (distinct `pyramid`) + `rclone
lsf R:ctbk/ --dirs-only` at execution time.

## Rename surface (one coherent pass)
1. **R2**: move survivor shards to clean prefixes (`avail-v6/`→`avail/`, …). Big
   objects → server-side copy on the account, then delete old.
2. **D1**: rewrite `pyramid_shards`/`pyramid_watermarks` `pyramid` values + `key`
   column to clean names/prefixes; drop superseded rows. (`rg_manifest` is a
   lazy cache — just purge; it re-fills.)
3. **api**: `PYRAMIDS` map keys + `keyTemplate`s, `DEFAULT_PYRAMID`, route
   strings (`serveAvailV3`→`serveAvail`, path `/api/avail-v3`→`/api/avail`),
   `RECONCILE_PYRAMIDS`, og/reconcile prefixes.
4. **FE**: `API_BASE` route paths, `availPyramid` flag (drop `avail-v5/v6`
   options), cache keys (`station-avail-v5`→…), `availSrc` legacy escape hatch
   (retire `totals`?), comments.
5. **configs/pyramids/*.yaml**, **`ctbk gbfs` CLI** subcommands/flags that name
   versions, **engine** (`ctbk_engine_src` factory names), **gbfs-compact.yml**
   fill steps, **docs/specs** (CLAUDE.md, pipeline.md, prior specs).
6. **Pin mechanism**: keep `?pyramid=`/`DEFAULT_PYRAMID` dormant; remove the
   version-named flag UI. (Decision: keep vs. fully remove the flag.)

## Sequencing
1. Complete RAC→HCCS cutover on the *current* (versioned) names.
2. Then this pass on HCCS: purge losers → re-key survivors to clean names →
   update api/FE/config/CLI/docs → coordinated FE+API deploy → verify.
3. One-shot verification: no `-v[0-9]` in code/config/docs; every FE view + the
   engine/GHA fill path resolves against clean names.
