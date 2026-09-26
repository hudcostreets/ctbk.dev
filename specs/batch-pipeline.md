# Batch pipeline: noninteractive trips-DAG regen on AWS Batch (HCCS)

Status: Phase 0 implemented on `batch-dag` (2026-09-26). The IaC, image, entrypoint, `ctbk regen` and the `regen.yml` workflow are ready; nothing is provisioned or submitted yet.

**Goal:** regenerate any slice of the trips pipeline, from a few months to the full history, as AWS Batch jobs submitted from a laptop or GHA, instead of booting `e` and running commands by hand. The immediate driver is the trailing-zero station-id repair ([station-id-trailing-zero.md]): re-`cons` 59 months, redo the station-keyed stages, harmonize, then rebuild the rides pyramids.

## TL;DR

- **Most of this already exists.** [batch-reproc.md] built and validated the harness on RAC: the `batch/` image and entrypoint, and dvx's Batch executor. Its first full reproc ran **all 1,363 cmd-bearing targets in 39 min on one 16-vCPU Graviton Spot task, ~$0.20**, green. The RAC infra is gone; this spec moves it to HCCS and turns the audit harness into a publish-capable regen tool.
- **Recommendation: do the repair on Batch.** The setup is one `pulumi up`, one secret value, one image push and a config bump; then three jobs plus the unchanged rides-rebuild steps. Batch cost is ≈ **$1.5** total (mostly the existing rides rebuild), ≈ **2 h wall**, with checkpoints between phases rather than hours of hand-run commands on `e`. The risk is first-run friction on new HCCS networking and push-back; the RAC reproc took several rounds. **Smoke one month first.**
- **Wide fanout isn't needed yet.** The single-job DAG (dvx level-parallelism, `-j 16`) already clears the full history in ~40 min. Month-sharded multi-job fanout is a Phase 3 option if the full regen passes ~1 h.

## The DAG

Per-month (EP) stages fan out within one job via `dvx run -j`; the barriers are whole-history.

| # | Stage | Scope | DVX-runnable? | Runs where | Notes |
|---|---|---|---|---|---|
| 1 | `norm` | per month (EP) | ✓ | regen job | reads `s3://tripdata` (task role); pinned via `--cached` in a partial regen |
| 2 | `cons` | per month, deps: 4 `norm` months | ✓ | regen job | the trailing-zero fix lives here |
| 3 | `smh -gin` / `-gil` | per month | ✓ | regen job | |
| 4 | `agg` `e_c`, `se_c`, `ymrgtb_cd` | per month | ✓ | regen job | |
| 4b | `agg` `ymrgtbs_cd`, `ymrgtbe_cd` | per month | ✗ (no `meta.computation`, bucket C in [batch-reproc.md]) | script job | `ctbk agg create -w1 …` until provenance lands |
| 5 | `sm`, `spj` | per month | ✓ | regen job | |
| 6 | `station-harmonize create -f` | **barrier**: every `cons` + meta_hist | ✗ (git-tracked outputs + a cmd-less `station-observations.parquet.dvc`) | script job | 64 GiB is ample for ~5–8 GB of inputs |
| 7 | `station-luc-build`, `rides-canonicalize-map -u`, `rides-merge-review`, `station-geo.json` | whole history, minutes | ✗ | laptop / GHA | small, and they need review (LUC churn) |
| 8 | engine image (`ctbk-engine`) | — | ✗ | laptop / GHA (docker) | Fargate has no docker daemon |
| 9 | `normalized-mirror`, `invalidate`, pyrmts-engine fill, `canonicalize`, `register`, `manifest backfill/prune` | rides pyramids | ✗ | existing flow: `hccs-aws.sh ctbk gbfs …` + pyrmts-engine Batch | already on Batch, and already noninteractive |

## How it runs

**Image:** `batch/Dockerfile` bakes a blobless clone of `main` (or `REF`) plus `uv sync`, and dvx `[s3]` at the project pin (`93e790a6c`). The job runs the image's code, so merge code fixes and rebuild before a regen.

**Entrypoint** (`batch/entrypoint.sh`):
- `dvx run …` mode: with no `.dvc` args, targets are expanded in-container from `$REGEN_TARGETS` (a [`batch/regen-targets`] spec: months × families), or the full `batch/reproc-targets` set. The 59-month repair list is 20.9 KB, over Batch's 8,192-byte `containerOverrides` cap. `$DVX_CACHED` adds `--cached` pins.
- `script '<sh>'` mode: runs a snippet of `ctbk` commands for non-DVX steps, then `dvx push -r r2`.
- `$BASE_REF` chains jobs: it checks out an earlier job's results branch's `s3/` data pointers. Harmonize must read the *regenerated* `cons` md5s, which exist only on the first job's branch.
- Every job ends with **one** commit of changed tracked files to `regen-results/<ts>`. There are no per-stage pushes; those race, per crashes' lesson.

**Where outputs land:**
- **Data:** blobs go to the prod `r2` remote (`--push each`, so a Spot reclaim loses at most the in-flight stage). The cache is content-addressed, so new blobs never overwrite old ones.
- **Pointers:** the `.dvc` pointers and git-tracked outputs go to the results branch.
- **Publishing:** nothing is live until that branch merges to `main`. Review the diff first: for the repair, expect `.dvc` md5 changes only in the 59 months and station-keyed families, and `station-id-map.json` changes matching the preview.

**Forced partial regen:** `dvx run -f` forces upstream stages too; verified by dry-run, `-f` on a `cons` target also re-runs its four `norm` dirs. `ctbk regen` therefore pins `--cached 's3/ctbk/normalized/??????' --cached 's3/ctbk/normalized/v0/*'`. Dry-run of the repair set: **472 computations, 5 levels, 68 upstream skips**, exactly the target set.

**Secrets:** Secrets Manager → Batch `secrets` → env, read by the execution role. Values never enter the image, the job def or Pulumi state.
- `ctbk/r2-access-key-id`, `ctbk/r2-secret-access-key` already exist; the engine uses them.
- `ctbk/github-rw-token` is new: a fine-grained PAT with `contents:write` on `hudcostreets/ctbk.dev`, for the push-back.
- The task role grants `s3://tripdata` reads, for `norm` in a full regen.

**Submitting:**
- **Laptop:** `ctbk regen …` (profile `h`).
- **GHA:** `.github/workflows/regen.yml` (dispatch), running `ctbk regen` under the `ctbk-gha` OIDC role. It watches the job's CloudWatch log and exits with its status.

## HCCS infra (`infra/aws_hccs.py` `_reproc`, stack `hccs`)

Named to match `dvx.batch`'s prefix convention, so `dvx batch submit -P ctbk-reproc` / `ctbk regen` find it.
- **ECR `ctbk-reproc`,** with a lifecycle policy: keep 4 tags, expire untagged after 7 days.
- **Log group `/ctbk-reproc/batch`,** 90-day retention.
- **Execution role `ctbk-reproc-batch-execution`:** ECS execution policy, plus an inline secrets policy for the 3 ARNs.
- **Task role `ctbk-reproc-batch-job`:** `s3://tripdata` read.
- **Compute environment `ctbk-reproc-spot`:** Fargate Spot, max 64 vCPU (four 16-vCPU jobs at once), on the pyrmts-engine subnets and SG.
- **Queue `ctbk-reproc`.**
- **Secret `ctbk/github-rw-token`;** its value is set out-of-band.
- **Job definition `ctbk-reproc`:** created once `reproc_image` is in stack config. ARM64, 16 vCPU / 64 GiB / 100 GiB ephemeral, `jobRoleArn`, reclaim-only retry. `dvx batch bootstrap` isn't used, because it bootstraps into default-VPC subnets and can't set a task role (dvx gap, drafted in `~/c/dvx/specs/batch-job-role-and-networking.md`).
- **`ctbk-gha` gains** `SubmitJob` on the queue and `job-definition/ctbk-reproc*`, plus log reads on `/ctbk-reproc/batch`.
- **Removed:** `infra/aws_reproc.py`, the RAC version (its resources were destroyed 2026-09-26), and its `manage_aws` gate.

`pulumi preview -s hccs` (read-only, 2026-09-26): **+11 create, ~1 update (the `ctbk-gha` policy), 28 unchanged, 0 delete or replace.**

## The repair, on Batch

Prereq: the fixes (`cons`, the harmonize guard, the owner's `3104`/`233` decisions) are merged to `main`.

```bash
# 0. one-time infra (user)
cd infra && CLOUDFLARE_API_TOKEN=$CF_PULUMI_HCCS_TOKEN CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID_HCCS AWS_PROFILE=h pulumi up -s hccs
AWS_PROFILE=h aws secretsmanager put-secret-value --secret-id ctbk/github-rw-token --secret-string "$PAT"
# 1. image at the fixed main, then point the job def at it
AWS_PROFILE=h dvx batch push -c batch -p linux/arm64 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:$(git rev-parse --short main)
pulumi config set -s hccs reproc_image 688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:<sha> && pulumi up -s hccs
# 2. smoke: one affected month, all families
AWS_PROFILE=h ctbk regen -w -m 201801
# 3. the 59 months (472 targets) → regen-results/<ts1>
M=201306,201507-201912,202006-202008,202010
AWS_PROFILE=h ctbk regen -w -m $M
# 4a/4b, in parallel, both chained on <ts1>:
AWS_PROFILE=h ctbk regen -w -b regen-results/<ts1> -s 'dvx pull s3/ctbk/normalized/*.parquet.dvc s3/ctbk/stations/meta_hists/*.dvc && ctbk station-harmonize create -f && dvx add s3/ctbk/stations/station-observations.parquet'
AWS_PROFILE=h ctbk regen -w -b regen-results/<ts1> -s 'for r in 201306 201507-201912 202006-202008 202010; do ctbk agg create -w1 -g ymrgtbs -acd $r && ctbk agg create -w1 -g ymrgtbe -acd $r; done'
# 5. review + merge the branches (4a/4b each contain <ts1>'s changes; resolve by taking both s3/ sides)
# 6. steps 7–9 of station-id-trailing-zero.md as today (LUC build → canonicalize map → geo → engine image → mirror → rides rebuild → validate)
```

In the 4b snippet, `ctbk agg create` pulls its `cons` inputs as deps. If it doesn't, prefix `dvx pull` of those months' `cons` `.dvc`s; the smoke in step 2 shows which.

## Estimates

**Fargate Spot, arm64:** ≈ $0.0097/vCPU-h + $0.0011/GB-h (≈ 70% off on-demand), so a 16 vCPU / 64 GiB task costs ≈ **$0.24/h**.

| Run | Wall | Batch $ | Basis |
|---|---|---|---|
| Smoke (1 month) | ~5 min | <$0.05 | image pull + ~8 stages |
| Repair DVX job (472 targets) | ~15 min | ~$0.06 | ≈ ⅓ of the 39-min full reproc |
| Harmonize script job | ~20–30 min | ~$0.10 | pull ~6–8 GB of `cons` from R2 + harmonize |
| `ymrgtb{s,e}_cd` script job | ~10 min | ~$0.04 | 118 aggregations, in parallel with harmonize |
| Rides rebuild (existing) | ~40 min | <$1 | ~20 min per anchor on the pyrmts-engine CE (G1's estimate) |
| **Repair total** | **~2 h** incl. review / manual steps 7–8 | **≈ $1.5** | |
| Full regen (all 159 months + harmonize) | ~1–1.5 h | ~$0.5 | 39-min reproc (1,363 targets) + harmonize + bucket-C script |
| Repair on `e` (today's plan) | "a few hours", hands-on | instance-hours | sequential `cons`/`smh`/`agg` + harmonize on one box, driven by hand |

## Lift

**To run the repair on Batch now (Phase 0 → 1), done on `batch-dag`:** IaC, entrypoint modes (`REGEN_TARGETS`, `DVX_CACHED`, `script`, `BASE_REF`, prod `r2` creds), `batch/regen-targets`, `ctbk regen`, `regen.yml` and tests.

**Remaining, for the user:** `pulumi up`, a PAT plus `put-secret-value`, image push plus the config bump, then the smoke run. First-run debugging risk is concentrated in:
- HCCS VPC egress: the pyrmts-engine subnets already reach R2 and ECR, so this is low;
- the push-back PAT;
- `BASE_REF` fetch-and-checkout on a blobless clone (fetching a branch is fine; untested live).

## Rollout

- **Phase 0 (this branch):** infra code, regen tooling, workflow. No spend.
- **Phase 1:** provision, smoke one month, run the repair. It doubles as the first HCCS validation of the harness.
- **Phase 2, provenance completion:** give `ymrgtbs_cd` / `ymrgtbe_cd` / `s_c` real `meta.computation` (`prep` wiring). Make harmonize a DVX stage (`cmd` + deps on every `cons` / meta_hist, with its git-tracked outputs as `outs` or a stamp). Then one `ctbk regen` covers stages 1–6 with no script jobs, and `batch/regen-targets` loses its gaps.
- **Phase 3, CI on Batch:** move the monthly `ctbk update` from the GHA runner (disk and time bound) to a regen job, with GHA as orchestrator only. Optionally add month-sharded fanout (K jobs over disjoint month sets, then a harmonize barrier job, `ctbk regen -m` per shard, no dvx changes) if full-regen wall passes ~1 h. dvx's own "Phase 2" (per-stage jobs with `dependsOn`) isn't needed at this scale.
- **Phase 4, rides orchestration:** chain steps 7–9 (canonicalize map → image → mirror → engine fill → canonicalize → register → manifest) into one dispatchable workflow, gated on the results-branch merge.

[station-id-trailing-zero.md]: station-id-trailing-zero.md
[batch-reproc.md]: batch-reproc.md
[`batch/regen-targets`]: ../batch/regen-targets
