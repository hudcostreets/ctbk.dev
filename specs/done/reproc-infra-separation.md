# Separate ctbk's reproc Batch infra from nj-crashes (stop the shared-`dvx` collision)

Status: proposed (2026-08-31). Fell out of Phase 1 of `batch-reproc.md`: two ctbk reproc smokes were broken by ctbk and nj-crashes **sharing** `dvx`-named AWS Batch resources in the reused pyrmts account (`006196295121`). Companion to `iac-finish-the-stack.md` (Axis 2 — who manages it) — this is the concrete "the imperative `dvx batch bootstrap` collides across projects" case that motivates Pulumi-managing the reproc infra.

## The collision (observed, not hypothetical)

`dvx batch bootstrap` creates AWS resources under fixed, dvx-namespaced names — **not** project-namespaced. Both ctbk and nj-crashes run their reproc in the same account, so they write the *same* resources; last bootstrap wins:

| Resource | Name | Shared? | Failure it caused |
|---|---|---|---|
| Job definition | `dvx` | **yes** | Revisions alternate `ctbk-reproc:*` ⇄ `nj-crashes-reproc:*`; `submit` uses the latest, so a ctbk submit can launch the crashes image (or a stale ctbk one) unless re-registered immediately before. |
| Execution role | `dvx-batch-execution` | **yes** | — |
| Role inline policy | `dvx-batch-secrets` | **yes** | crashes' bootstrap overwrote it to grant `secretsmanager:GetSecretValue` on **only** `nj-crashes/*`. ctbk's Fargate task then failed at startup: `AccessDeniedException … not authorized to perform secretsmanager:GetSecretValue on ctbk-reproc/github-rw-token` (smoke #2, `ResourceInitializationError`). |
| Compute env / queue | `dvx-spot` / `dvx` | **yes** | Shared Spot CE + queue; fine functionally but same last-writer-wins config risk. |
| Log group | `/dvx/batch` | **yes** | Streams interleave; `submit --watch` sometimes can't find the stream. |
| ECR repo | `ctbk-reproc` | no (ctbk) | — |
| Secrets | `ctbk-reproc/{github-rw-token,r2-access-key-id,r2-secret-access-key}` | no (ctbk) | — |

**Stopgap already applied (2026-08-31):** added a *separate* scoped inline policy `ctbk-reproc-secrets` to the `dvx-batch-execution` role granting `GetSecretValue` on `ctbk-reproc/*` — additive, so crashes' `dvx-batch-secrets` bootstraps don't remove it. Unblocked the smoke without disturbing crashes. This is a patch, not the fix: the job def, CE, queue, and role are still shared.

## Target: dedicated, Pulumi-managed `ctbk-reproc-*` infra

Give ctbk's reproc its own namespace so nothing crashes touches can clobber it, and manage it in ctbk's existing `infra/` Pulumi stack (today Cloudflare-only; add an AWS provider pinned to the pyrmts account/profile). Names:

| Resource | Proposed name | Import or create |
|---|---|---|
| ECR repo | `ctbk-reproc` | **import** (exists) |
| Secrets ×3 | `ctbk-reproc/*` | **import** (exist) |
| Execution role | `ctbk-reproc-batch-exec` | create (AmazonECSTaskExecutionRolePolicy + inline: `GetSecretValue` on `ctbk-reproc/*`, `kms:Decrypt`) |
| Log group | `/ctbk-reproc/batch` | create |
| Compute env (Fargate Spot) | `ctbk-reproc-spot` | create (default-VPC subnets/SG, max 16 vCPU, ARM64) |
| Job queue | `ctbk-reproc` | create |
| Job definition | `ctbk-reproc` | create (image, 16 vCPU / 64 GiB, ARM64, the 3 secrets, `REPROC_URL`/`REPROC_ENDPOINT` env, role above) |

Default-VPC subnets/SG (what `dvx batch bootstrap` auto-discovers today) keep this self-contained — no dependency on pyrmts' Pulumi networking. The job def's container config is otherwise byte-for-byte what `dvx:31` held (captured in `tmp/jobdef-31.json` during Phase 1).

## The load-bearing open question: dvx tooling assumes `dvx`-named resources

`dvx batch submit` / `bootstrap` hardcode the `dvx` queue + job-def names (the local pin `9c22fc08c` has no `--queue`/`--job-def`/`--name-prefix` override). So dedicated `ctbk-reproc-*` names only work if one of:

1. **dvx gains a `--name-prefix` (or `--queue`/`--job-def`) option** on `bootstrap`+`submit` — the clean general fix; each project bootstraps + submits under its own prefix, and the whole collision class disappears without Pulumi. **Recommended** — it's a small dvx change and it's the actual root cause (shared names), and it helps crashes too. Pulumi can then import the prefixed resources for drift/IaC.
2. Pulumi creates `ctbk-reproc-*` and we submit with **raw AWS** (`aws batch submit-job --job-queue ctbk-reproc --job-definition ctbk-reproc …`), bypassing `dvx batch submit`. Loses dvx's target-appending + watch conveniences (the entrypoint already appends `batch/reproc-targets`, so this is viable).

Recommendation: do **(1)** in dvx first (unblocks cleanly, fixes the root cause for both projects), then Pulumi-import the prefixed resources under `iac-finish-the-stack.md`'s AWS-coverage increment. Until then, the Phase-1 runbook must **re-register the `dvx` job def to the ctbk image immediately before each submit** (crashes may have bootstrapped since) and rely on the additive `ctbk-reproc-secrets` policy.

## Not in scope

- Migrating the reproc *off* AWS — it stays on Batch (Workers can't run it); this is purely Axis-2 (management) + de-collision.
- The pyrmts networking (VPC/subnets/SG) — reproc uses the default VPC; no cross-stack reference needed.

## Resolution (2026-09-02) — done

Both prongs of the open question landed:

1. **dvx `3de35246c` added `-P/--prefix`** on `bootstrap`+`submit` (default `dvx`), so the shared-name collision class is fixed at the root for every project — `<prefix>-batch-execution`, `<prefix>-spot`, queue+job-def `<prefix>`, log group `/<prefix>/batch`.
2. **Pulumi now manages the dedicated `ctbk-reproc-*` stack** (`infra/__main__.py`, AWS provider pinned to the `r` profile / pyrmts account): execution role `ctbk-reproc-batch-execution` + scoped `GetSecretValue` on `ctbk-reproc/*`, log group `/ctbk-reproc/batch`, Fargate-Spot CE `ctbk-reproc-spot` (default-VPC subnets/SG, ARM64, 16 vCPU / 64 GiB, 200 GiB ephemeral), queue + job def `ctbk-reproc`. We submit with **raw `aws batch submit-job`** (the entrypoint appends `batch/reproc-targets`), so no re-register-before-submit dance and nothing crashes bootstraps can clobber. The 3 secrets and the ECR repo pre-exist and are referenced by ARN (values stay out of Pulumi/state).

Two corrections found while standing it up:
- **`networkConfiguration.assignPublicIp: ENABLED`** is required — the default-VPC subnets are public (IGW, no NAT), and a Fargate awsvpc ENI reaches Secrets Manager / ECR / S3 only with a public IP (subnet `MapPublicIpOnLaunch` doesn't apply to awsvpc ENIs). Without it the task times out pulling secrets at init.
- **200 GiB ephemeral** (not the 20 GiB default / 100 GiB first try) — the cons stages fill 100 GiB.

Validated end-to-end: a full-DAG from-scratch reproc (job def `ctbk-reproc:4`, image `a6eef4b5`) executed all 1435 stages with **zero md5 changes** — the whole ctbk DAG reproduces byte-for-byte from committed provenance (the one blocker, a 202605 cross-dump-dedup assert, was fixed separately in `cons`).
