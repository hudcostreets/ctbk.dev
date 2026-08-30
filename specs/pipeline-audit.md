# ctbk pipeline audit (2026-08-30): what runs, what's stored where, what's safe to move/delete

Status: reference + plan (2026-08-30). Written before completing the S3→R2 migration (`s3-to-r2-migration.md`) and before any archival deletion, because the deletion touches data that is partly still live and whose DVX provenance is incomplete. Synthesized from a code+docs+www+session-history audit (four parallel passes) and a `/read` of the `dvx` session's reproducibility work.

The point: establish the *actual* current-state model (docs are materially stale), classify every `s3://ctbk` prefix, and define the reproducibility test that must pass before we retire anything.

## 1. The system, as it actually is (2026-08)

Two serving migrations moved the site off the old flat-JSON/plain-key world:

1. **System/region rides** (the homepage chart): `ymrgtb_cd.json` → **rides-v5**, the pyrmts pyramid — engine-built on AWS Batch, registered in D1 `pyramid_shards`, served by the CF api worker (`/api/rides-v5`, default). Plans arbitrary `{station-subset × bin × range}`. `ymrgtb`/`ymdgtb` survive only as (a) trace-module names, (b) `aggregated/*.parquet` build inputs, (c) a `?tsrc=legacy` FE fallback pending "Phase E" deletion.
2. **Per-station trips**: served from the **DVX content-addressed cache directly** (`s3://ctbk/.dvc/files/md5/…` via a build-time `ymdgtb-index.json` manifest); default per-station path is now `/api/rides-v3`. No plain-key mirror, no D1.

### Storage taxonomy — three separate universes on two providers

| Universe | Where | What | DVX-tracked? |
|---|---|---|---|
| **DVX blob store** | `s3://ctbk/.dvc/files/md5/…` | Canonical trips-pipeline outputs (normalized, consolidated, aggregated, meta_hists, station JSONs, ymdgtb) — content-addressed | Yes |
| **Plain-key mirrors** | `s3://ctbk/<prefix>/…` | Human-readable copies at month-keyed paths. **Only `normalized/` is live** (see §2) | No (copies of DVX blobs) |
| **R2 (`ctbk` bucket)** | CF R2 | rides-v3/v5 pyramids, avail-v3/v5/v6 pyramids, `gbfs/status|info|stations`, `station-luc.json` | **No** — entirely outside DVX |

Corollary: the S3→R2 migration (moving the DVX blob store + the `normalized/` plain-key) and the R2-side legacy-pyramid GC (`gc-legacy-pyramids.md`) operate on **different data**. Don't conflate them.

### Stage list (current, from `ctbk update` — NOT the stale `update.sh`)

Monthly driver is `ctbk update -S -ccda <ym>` (`ctbk/update.py`), a superset of the orphaned `update.sh`. Stages: `norm` (reads `s3://tripdata` zips directly) → `cons` → {`smh -gil/-gin`, `agg` ×5: `e_c`/`se_c`/`ymrgtb_cd`/`ymrgtbs_cd`/`ymrgtbe_cd`} → `sm` → `spj` → `station-trips-json` (ymdgtb) → `gen-station-urls.js`. Then, outside `update`: `gbfs rides-v5-extend` (Batch pyramid build + the `normalized/` plain-key mirror) and `station-luc-build`. The `csv` stage is **orphaned** (norm bypasses it; frozen at 202501). `station-harmonize` is skipped monthly (CI passes `-S`).

## 2. `s3://ctbk` prefix classification (git-verified)

The plain-key mirrors froze at commit **`a00af68c`** (2025-02-09 CI rework): stages stopped running with `--s3`, so they write local + DVX blobs only, and consumers moved to reading `.dvc/files/md5/…` directly.

| Prefix | Size | DVX latest | Plain-key latest | Status | Verdict |
|---|---:|---|---|---|---|
| `.dvc/` (blob store) | 204 GB | 202607 | n/a | **live canonical** | **migrated ✅** (done 2026-08-30, 0-diff) |
| `normalized/` (plain-key) | 12 GB | 202607 | 202607 | **LIVE** — rides-v5 Batch factory *lists* it for month-discovery; `rides-v5-extend` mirrors it monthly | **migrate + keep writing** — move the mirror target *and* the factory listing to R2 together; never delete |
| `aggregated/` (plain-key) | 1.4 GB | 202607 | 202411 | mirror retired, DVX current | **archive → drop link** (DVX blobs are the live copy) |
| `stations/` (plain-key) | 0.9 GB | 202607 | 202411 | mirror retired, DVX current | **archive → drop link** |
| `csvs/` | 43 GB | 202501 | 202501 | **whole stage retired** ~Feb 2025 — norm reads tripdata zips directly; no fresher DVX copy | **archive → delete** — dead regenerable intermediate, cleanest deletion candidate |

Nothing gets deleted before §4's reproducibility test passes. `normalized/` is the only plain-key with a live consumer.

## 3. DVX DAG provenance gaps (why we can't trust the graph to decide deletion)

The `.dvc` sidecars **under-record** dependencies in three places, so a reachability query would *understate* what old artifacts are still inputs:

1. **Consolidated** (`normalized/YYYYMM.parquet.dvc`): provenance is actually recorded for months **≤ 202511** — full `meta.computation` with `cmd` and the complete multi-source-month `deps` (e.g. 202006 lists 16 `normalized/*/…_202006.parquet` + `v0/…` inputs). But the **last 8 months (202512–202607) have *no* `meta.computation`** — bare `dvx add`-style outs. This is a **temporal regression at the head of the DAG** (consolidation stopped recording provenance ~Dec 2025), not the blanket "no deps" the first pass claimed. Verified 2026-08-30: 8 of 158 top-level consolidated `.dvc` lack a computation block, all contiguous at the head.
2. **`ymrgtbs_cd` / `ymrgtbe_cd`** aggregates have **no `meta.computation`** (all months) — they look like imported leaves. (`ymrgtb_cd`, `e_c`, `se_c`, `s_c`, `meta_hists/{in,il}` all *do* record computation.)
3. **`ymdgtb` / `station-observations`** are bare `dvx add` (no provenance). `ymdgtb` does a **whole-history rebuild** from *all* `ymrgtb{s,e}_cd_*` aggregates — those are load-bearing inputs across every month, not archival.

These are latent bugs (missing provenance) — exactly the class the `dvx` reproc exercise is designed to catch, and gap #1 additionally flags a **live** regression to fix in the `cons`/`ctbk update` write path (recent months should record computation like the backfilled ones do). Fixing them is a precondition for any confident GC of trips-pipeline data.

## 4. The reproducibility test (piggyback the `dvx` reproc work) — gate for any deletion

The `dvx` session (with its `crashes`/nj-crashes sibling) just built and hardened a full "rebuild the whole DAG from primary sources into a throwaway remote, then diff" workflow. ctbk should replicate it before retiring anything.

**Pin:** dvx `main` at a Git SHA ≥ `fad202ac5` (v0.6.0 is tagged but **unpushed**; everything below is past the v0.5.0 PyPI release — `cache comm`, `gc --safe`, `run --remote`, `dvx batch`, `--pull-deps` default-on, multi-output `.dvc`, resource scheduling, the parallel-materialization fixes). When v0.6.0 is pushed, switch to the release pin.

**Procedure (mirrors `crashes/specs/batch-reproc.md`):**
1. **Separate reproc remote** so the audit never writes prod's cache — parameterize the S3 root via env to a `.reproc/` prefix (e.g. `CTBK_S3=s3://ctbk/.reproc`, analogous to their `NJC_S3`).
2. From a fresh clone, `dvx run --force --remote reproc --push each -j N <all targets>` (or `dvx batch submit` for Fargate). **`--force` is the crux** — without it stages fetch-or-skip and you learn nothing; with it every derived asset re-executes from primary sources.
3. **Diff:** `dvx cache comm remote:s3 remote:reproc --only 'reproc,!s3'` — every object reproc produced that prod's cache lacks = a stage whose output changed → a missing-dep or non-deterministic stage (expect the §3 gaps to surface here, plus the crashes-class leading-`/` path-resolution bugs).
4. **Acceptance invariant:** a fresh clone with the populated remote runs `dvx run <target>` = **zero cmds** (all fetch-or-skip). Any rerun is an undeclared dep or a non-reproducible stage.

**Gotchas (from their 9-round grind):**
- A typo'd `--remote` name **degrades silently** to "not in remote" → full rerun that pushes nothing. **Smoke one stage before the big job.**
- Deterministic outputs are required for the diff to mean anything; dvx's `output hash changed` warning + `Hash changed: N` summary flag non-reproducible stages.
- `dvx audit` (blob taxonomy INPUT/GENERATED/FOREIGN/ORPHANED, offline `-S` snapshot mode) exists but is on the `audit` branch / draft PR only — track that branch if we want it.

Cost/time on crashes' ~1,386 targets: ~$1–2, ~1–2 h on Fargate Spot. ctbk's trips DAG is comparable-order.

### Operational specifics (resolved 2026-08-30)

- **dvx pin.** ctbk currently pins dvx at `9c22fc08c` (Aug 28) in `pyproject.toml`, which **predates** `d507ed3aa` (`dvx run --remote`) and `fad202ac5` (parallel-mat fix) — the two features reproc needs. Bump to **v0.6.0 = `991de2871`** (contains both; the tag is unpushed but the SHA is reachable on `runsascoded/dvx` `main`, so a `rev = "991de2871"` git pin fetches it). `r/main` HEAD `95db406f7` additionally adds **AWS Batch Secrets-Manager creds** — prefer that SHA if reproc runs on Fargate/Batch (avoids baking creds into the container).
- **Isolation, don't flag-day the pin.** Do the reproc run with v0.6.0 in an **isolated env** (scratch venv or `e`/Batch), leaving the project's `pyproject.toml` pin at `9c22fc08c` until the reproc test *itself* validates v0.6.0 against ctbk's DAG. Only then bump the committed pin.
- **Reproc remote.** Add a **local** (`--local`, uncommitted) `reproc` remote pointing at a throwaway prefix — `s3://ctbk/.reproc` or R2 `.reproc` — so the audit never writes prod's `.dvc` store. Diff with `dvx cache comm remote:s3 remote:reproc --only 'reproc,!s3'`.
- **Target set** (leaf `.dvc`, per month unless noted): `aggregated/{e_c,se_c,s_c,ymrgtb_cd,ymrgtbs_cd,ymrgtbe_cd}_YYYYMM.parquet`, `stations/meta_hists/{in,il}_YYYYMM.parquet`, `aggregated/YYYYMM/{stations.json,se_c.json}`, plus the whole-history `stations/ymdgtb` + `stations/station-observations`. Upstream: `normalized/YYYYMM.parquet` (cons) ← `normalized/YYYYMM/*.parquet` (norm) ← `s3://tripdata` zips. The **8 head months + the 3 gap stages** (§3) can't `dvx run` cleanly and will surface first.
- **Run location** (needs sign-off — heavy compute + cloud cost): (a) *local slice* — a few months, `-j 1`, proves the mechanism, no cloud; (b) *`e`* — full DAG, ~1–2 h, requires starting the instance; (c) *Fargate/Batch* — full, ~$1–2, needs the Batch path + the `95db406f7` Secrets pin.

## 5. Documentation staleness (found during the audit — needs updating)

- **`update.sh`** (repo root): orphaned/stale — quotes a flow (`ctbk ymrgtb-cd -f`) that predates `ctbk update`. **Delete or replace** with a pointer to `ctbk update`.
- **`CLAUDE.md`** "Data Pipeline Flow": omits `consolidated`, `ymrgtbs/e`, `ymdgtb`, and the rides-v3/v5 + avail pyramids; quotes the stale `update.sh`; "public access via ctbk.s3.amazonaws.com" understates that most data is DVX-CA-served and the app increasingly reads R2; Testing note ("only test_csvs.py") is wrong.
- **`ctbk/README.md`**: mermaid still shows `z→c→n` (csv between zip/normalized — csv is orphaned); omits cons/pyramids/harmonize; three inconsistent `meta_hists/` path forms; wrong `spj` "See also" path; CI description predates the single `ctbk update` invocation.
- **`ctbk/cli/base.py`** (the `--help` docstring the README mirrors): same stale `meta_hists/YYYYMM/KEYS.parquet` path.
- **`www/src/pages/Pipeline.mdx`** (the on-site `/pipeline` page): presents the legacy per-station JSON flow as primary (it's `?tsrc=legacy` now); calls the already-shipped multiscale pyramid "planned"; describes the retired D1 hot-cache avail path; implies `aggregated/*.parquet` are the web-viz source (they're build inputs now); never mentions that the homepage rides chart is served by the pyrmts worker. `PipelineDiagram.tsx` hardcodes 7 stages, omitting `csv`/`v0`/`partition` present in `dag.json`.
- **`docs/pipeline.md`**: most current of the set; minor — reconcile the `ymrgtb-cd` vs `ymdgtb-cd` alias, and it doesn't mention the `normalized/` plain-key mirror.

## 6. Sequenced plan

Independent workstreams; ordered by unblock value.

1. **Finish the frontend read-shift** (caps the $11.38/mo S3 egress) — repoint the `.dvc/` hostnames to `data.ctbk.dev` (already live + verified). Independent of everything below. Sites: `useStationTrips.ts`, `StageCard.tsx`, `gen-station-urls.js` + regen `station-urls.json`; Footer index link stays on S3 (no R2 auto-index). Do via a single `VITE_DATA_BASE`-overridable constant; CIC before deploy.
2. **DVC remote → R2 shift-writes** — repoint `.dvc/config` so `dvx push` lands in R2; add the R2 CI secret. Independent.
3. **`normalized/` → R2** (pyrmts-coordination) — `rides-v5-extend` mirror copies into R2, and the engine's rides factory lists R2 for month-discovery. Dual-write S3+R2 until the engine is confirmed on R2, then retire the S3 mirror. Needs the pyrmts/avail side.
4. **Fix the §3 DVX provenance gaps** + run the §4 reproc test. Precondition for #5.
5. **Archive + retire the frozen prefixes** — only after #4 is green: copy `aggregated/`/`stations/`/`csvs/` to R2 for preservation, then unlink public S3 (and delete `csvs/` outright, being pure dead intermediate). Never a flag-day; keep S3 read-only first.
6. **Doc refresh** (§5) — fold into whichever commits operationalize the above so docs track reality.
