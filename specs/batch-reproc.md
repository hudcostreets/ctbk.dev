# Batch reproc: rebuild the ctbk trips DAG from scratch on Fargate Spot

Status: proposed (2026-08-30). The ctbk side of the reproducibility audit — the deletion gate from `pipeline-audit.md` §4. Mirrors the proven `~/c/hccs/crashes/specs/batch-reproc.md` (10 Fargate rounds, 2026-08-29) and rides on the reusable `dvx batch` tooling (`~/c/dvx/specs/done/batch-executor.md`, `batch-secrets-manager.md`).

## Why

Prove the trips pipeline regenerates byte-for-byte from primary inputs. Today the only full-reproc venue is a laptop; CI runs incremental slices, so a whole class of "current code no longer reproduces its own committed output" bugs goes undetected (exactly what the crashes audit caught with `crashes.parquet`'s dropped victim-count columns). `pipeline-audit.md` §3 already found three provenance gaps by static inspection; a from-scratch rebuild confirms them and surfaces any others before we archive/delete legacy prefixes.

On-demand, ~$1–2/run, zero idle cost — not standing infra.

## What makes ctbk's reproc *simpler* than crashes'

Verified 2026-08-30:

1. **No side-effect S3 writes in the target DAG.** The core trips stages (`norm`, `cons`, `agg`, `smh`, `sm`, `spj`, `station-trips-json`) write their tracked `outs` only — the `--s3` plain-key mirror writing was dropped at commit `a00af68c` (~Feb 2025; it's why the plain-key mirrors froze). The `put_object` side-effect writers (`avail_*.py`, `rides_v1.py`, `station_luc.py`) are all on the **avail / rides-pyramid / LUC** side, which is **not** part of this DAG. So ctbk does **not** need the crashes-style `$NJC_S3` root redirect for write-safety — a separate `--remote reproc` plus `--force` fully isolates the run from prod's `.dvc` store.
2. **Smaller side-effect exclusion set.** Because no trips stage publishes as a command side effect, there's little to tag `meta.computation.side_effect: true`. The one coupling to keep out is anything that would trigger the R2-only pyramid mirror (`gbfs rides-v5-extend` / `rides-v3-extend`) — but those aren't DVX targets, so they're naturally excluded.
3. **Read-fallback masking is the residual risk.** The remaining crashes-class trap is a stage silently rescued by reading a prod artifact its `.dvc` didn't declare as a dep. `--force` + a clean container cache (nothing pre-materialized) + pulling deps only from the `reproc` remote is what exposes those as `FileNotFoundError` rather than a quiet pass. The three §3 gaps (8 head-month `cons`, `ymrgtb{s,e}_cd`, `ymdgtb`/`station-observations`) are the known ones; the run finds the rest.

## dvx pin

The project pins dvx at `9c22fc08c` (Aug 28), which **predates** `d507ed3aa` (`dvx run --remote`) and `fad202ac5` (parallel-mat fix). The **container** builds on **`95db406f7`** (`r/main` HEAD) — it adds `dvx run --remote`, the parallel-mat fix, *and* AWS Batch Secrets-Manager creds (`-s NAME=ARN`), so S3/R2 keys never bake into the image. **Do not bump the committed `pyproject.toml` pin** until the reproc run itself validates `95db406f7`/v0.6.0 against ctbk's DAG; the run is the compatibility test.

## Target set

**Measured 2026-08-30: 1,363 in-scope targets** = every tracked `.dvc` with a `cmd:`, minus `side_effect: true` (none flagged yet). What's *naturally excluded* and why it sequences cleanly: the retired `csvs/` extract stage records no `cmd` (cmd-less leaves, nothing deps on them); the §3 gap stages (`ymrgtb{s,e}_cd`, `ymdgtb`, `station-observations`, and the 8 head-month `cons` 202512..202607) also have no `cmd`, so they join the target set only **after** their `meta.computation` is declared (§3 fix) — the first reproc covers the cmd-bearing stages, the gap stages come with their fix. In-scope families, per month unless noted:

| Family | Per-month | Notes |
|---|---|---|
| `aggregated/{e_c,se_c,s_c}_YYYYMM.parquet` | 3 | `agg -g{e,se,s} -ac` — EP fanout over months |
| `aggregated/{ymrgtb,ymrgtbs,ymrgtbe}_cd_YYYYMM.parquet` | 3 | `agg -g ymrgtb{,s,e} -acd`; the `s`/`e` variants are §3 gap #2 (no computation) |
| `stations/meta_hists/{in,il}_YYYYMM.parquet` | 2 | `smh -g{in,il}` |
| `aggregated/YYYYMM/{stations.json,se_c.json}` | 2 | `sm`, `spj` |
| `stations/ymdgtb`, `stations/station-observations` | — | whole-history; §3 gap #3 (no computation) |

Upstream (materialized from the `reproc` remote or rebuilt): `normalized/YYYYMM.parquet` (`cons`) ← `normalized/YYYYMM/*.parquet` (`norm`) ← `s3://tripdata` zips (leaves — **pinned, never re-fetched**; `--force` applies to derived targets only). The 8 head-month `cons` (§3 gap #1) can't `dvx run` cleanly and surface first.

## Runbook (mirrors crashes' resolved default)

1. **Reproc remote** — local (`--local`, uncommitted) DVC remote at a throwaway prefix: `s3://ctbk/.reproc` or R2 `.reproc`. Never prod's `.dvc`.
2. **Results branch, single atomic push** — the run is level-*parallel*, so per-stage `git commit`/`git push` **race** on the ref lock ("cannot lock ref … is at X but expected Y") and losing stages' commits never escape (crashes' round-1..10 lesson). So `dvx run --no-commit` (dvx still *writes* the regenerated `.dvc` md5s into the worktree — it just doesn't git-commit), and after the parallel run the entrypoint does **one** `git add -u && commit && push` to a `reproc-results/<UTC-ts>` branch. That branch, diffed against the base commit, **is** the reconciled result — every `.dvc` hash change is a finding. Cross-round resume: re-submit off that branch, so the last round's regenerated md5s are already recorded and their blobs are in `reproc` → passed stages materialize (fetch) instead of recomputing.
3. **Container** — `batch/Dockerfile` (built): self-contained `python:3.13-slim` + `uv` + a blobless clone + `uv sync --frozen --no-dev`, then dvx **overridden** to `$DVX_REF` (default `95db406f7`) past the committed `9c22fc08c` pin. No node (www excluded). Entrypoint `batch/entrypoint.sh`. Build arm64, then `dvx batch push <ecr-image>`.
4. **Bootstrap** — `dvx batch bootstrap -i <ecr-image> -a ARM64 -s S3_KEYS=<arn> …` creates the Spot compute-env + queue + job-def (Graviton, ~20% cheaper). **Provisions AWS resources** — the gated step.
5. **Submit** — `dvx batch submit -f -r reproc -p each -w <targets>`. ~1–2 h wall on one 16-vCPU Graviton Spot task, ~$1–2. `-O` (on-demand) for a guaranteed no-reclaim pass (~3×).
6. **Diff** — `dvx cache comm remote:s3 remote:reproc --only 'reproc,!s3'`: every blob reproc produced that prod's cache lacks = a changed output → an IDP bug, an undeclared dep, or benign writer/schema drift. Classify (crashes' `pqt-audit` split changed-md5 into identical/metadata/encoding/schema/content; **only `content` is a real divergence**). The `audit` branch diffed against the base commit *is* the reconciled result.

## Acceptance

- From-scratch run completes green; every DT stage pushes a byte-identical md5. ND stages get documented in their `.dvc`.
- Diverging `content` md5s are **findings** (IDP bug or undeclared dep), not failures — this is the point.
- A fresh clone + populated `reproc` remote runs `dvx run <target>` = **zero cmds** (all fetch-or-skip). Any rerun = an undeclared dep or non-reproducible stage.
- Then, and only then, the §3 provenance fixes land and the legacy-prefix archival/deletion (`pipeline-audit.md` §5, `s3-to-r2-migration.md`) is unblocked.

## AWS account — RESOLVED: reuse the pyrmts Batch account (2026-08-30)

Run in **the account where the pyrmts pyramid engine already runs Batch** (its ECR is `<acct>.dkr.ecr.<region>.amazonaws.com/pyrmts-engine:<rev>`; `python/pyrmts_engine/src/pyrmts_engine/batch.py` owns its compute-env/queue/job-def, and `python/pyrmts_pulumi/` manages the account's VPC/subnets/SG/roles). Reuse plan:
- **Networking/IAM:** borrow the engine's VPC/subnets/security-group and the Fargate execution role — no new networking to stand up.
- **Provisioning:** the reproc container is ctbk-trips-specific (not the engine image), so it still gets its **own** `dvx batch bootstrap` (Spot CE + queue + job-def, ARM64/Graviton) — just in this account, pointed at the engine's subnets/SG. Keeps the reproc's throwaway infra distinct from the live engine's.
- **Creds:** S3 read + `reproc`-remote write (and R2 if the reproc remote lands on R2) via a Secrets-Manager ARN in this account, granted at `bootstrap --secret`.
- **Concrete specifics still to pull** before `bootstrap`: the account id, region, subnet ids, and SG id — from the pyrmts deploy config / Pulumi stack outputs (`python/pyrmts_pulumi`), not hardcoded (tracked files use placeholders).

This still gates step 4 (provisioning) and step 5 (spend) on a go. Steps 1–3 (remote, `audit` branch, Dockerfile + target script) are account-agnostic and built in Phase 0.

## Prereqs / phasing

- **Phase 0 (account-agnostic, no spend): DONE + validated 2026-08-30.** `batch/{Dockerfile,reproc-targets,reproc.sh,entrypoint.sh,README.md}` (commit `6f42d1dd`). arm64 build smoke green: image builds (1.44 GB), `uv sync --frozen` resolves, dvx overrides `9c22fc08c`→`95db406f7`, and `dvx run --remote` is present in the image (the feature the committed pin lacks). Still TODO in Phase 0 when Phase 1 starts: create the local `reproc` remote (`dvx remote add --local reproc s3://ctbk/.reproc`). Heavy DAG smokes go on Fargate/`e`, per crashes retro.
- **Phase 1 (gated on the account decision + go):** `bootstrap`, first `submit --watch`, iterate rounds on the `audit` branch until green.
- **Phase 2 (after green):** land §3 provenance fixes; classify divergences; unblock archival.
