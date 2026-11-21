# Repoint the `pyrmts-engine` fill job def to HCCS R2, creds via Secrets Manager

> **Done** (spec triage, 2026-11-19): `096c2c44` IaC'd HCCS Batch with Secrets Manager creds; `ctbk gbfs engine-jobdef --r2-secrets`.

Status: proposed (2026-09-12). Fixes an active correctness bug from the RAC→HCCS cutover; companion to `s3-to-r2-hccs.md` (Axis-1, where it serves) and `iac-finish-the-stack.md` (Axis-2, who manages it). This is the intersection: an Axis-1 repoint plus a first, deliberately-imperative slice of Axis-2 SSM.

## The bug

The AWS Batch `pyrmts-engine` job definition (account `006196295121`, us-east-1, rev 17, image `ctbk-engine:022c8df4`) bakes **RAC** R2 as plaintext container env:

```
R2_ENDPOINT_URL      = https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com   # RAC
R2_ACCESS_KEY_ID     = d61e54…(32)   # RAC R2 key (== .dvc/config.local reproc, == plaintext)
R2_SECRET_ACCESS_KEY = d19690…(64)   # RAC
secrets: []
```

`_engine_submit` passes **no** per-job R2 override, so every fill this job def runs — **rides-v5 and smg-v1/avail both** (one shared job def) — writes tiles/manifests to **RAC** R2, while the HCCS api worker serves from **HCCS** R2 and the registry POST lands in HCCS D1. Result: dangling references. Evidence: today's rides-v5 fill advanced the RAC manifest (2026-09-12) while the HCCS manifest stayed at the 2026-09-10 cutover snapshot.

Compute stays in the old AWS account (the account move is Lambda-quota-blocked, tracked separately). Only the **R2 write target** is wrong.

## The fix shape

`ctbk gbfs engine jobdef IMAGE` (`gbfs_cli.py:1387`) registers a new revision by reading the **latest** revision's `containerProperties` wholesale and swapping only `image`. So the shape is self-propagating: **seed one revision with the correct shape and every future image bump preserves it.** pyrmts' `batch.register`/`bootstrap` only emits `environment` (no `secrets`), so the one-time seed needs a small ctbk-side registration that emits a `secrets` block.

Correct shape (rev 18), diffed from rev 17:
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`: **removed from `environment`**, added to `secrets` as `{name, valueFrom: <SM ARN>}`.
- `R2_ENDPOINT_URL`: env, value flipped RAC → HCCS `https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com`.
- everything else (image, 8 vCPU / 32768 MiB, 100 GiB ephemeral, ARM64, `assignPublicIp: ENABLED`, log group `/pyrmts-engine/batch`, exec role `pyrmts-engine-batch-execution`) copied verbatim.

This mirrors the working precedent already in the tree: `infra/aws_reproc.py:119-148` (the `ctbk-reproc` job def) does exactly this `secrets`-block pattern.

## Secret scoping: engine-scoped, not shared

Two SM secrets, HCCS-namespaced to the engine — **not** reuse of the existing `ctbk-reproc/r2-*`:

- `ctbk/r2-access-key-id`   ← HCCS `CF_R2_RW` access key id
- `ctbk/r2-secret-access-key` ← HCCS `CF_R2_RW` secret

Rationale: `aws_reproc.py`'s reproc job def carries `REPROC_ENDPOINT=RAC` env **separately** from its `ctbk-reproc/r2-*` creds. Flipping those shared creds to HCCS would leave reproc with HCCS creds but a RAC endpoint — a broken half-migration of an on-demand harness that isn't the thing we're fixing. Engine-scoped secrets keep reproc coherent-on-RAC (migrate it as its own step, if/when). The `CF_R2_RW` token value is the same one already in the CI GH secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.

## Why Phase A stays imperative (loop-before-breadth)

`iac-finish-the-stack.md` is explicit: **do not widen Pulumi coverage (Increment 2) before the CI loop exists (Increment 1)** — a bigger stalled stack is worse than scripts. The loop is not built yet. The `pyrmts-engine` job def is *high-churn* (17 revisions; bumped on every engine image change via `gbfs engine jobdef`), so it is precisely the resource that would rot fastest inside an un-looped Pulumi stack.

So Phase A creates the SM secrets, IAM policy, and repointed revision **imperatively** — which does not touch (or deepen) the stalled Pulumi stack — and Phase B folds them into Pulumi *after* the loop, where the pre-existing secrets/role import as a no-op diff (the same way `aws_reproc.py` already references the reproc secrets by ARN, values out of state).

## Phase A — steps (imperative; unblocks the bug + delivers SSM)

Prerequisite input: the **HCCS `CF_R2_RW`** access-key-id + secret (same token as the CI GH secrets). Needed to populate SM.

1. **Create the SM secrets** (profile `r`, us-east-1):
   `aws secretsmanager create-secret --name ctbk/r2-access-key-id --secret-string <HCCS key id>` (and `…/r2-secret-access-key`). Values never enter git/Pulumi state.
2. **Grant the exec role read access.** Add an inline `RolePolicy` `secretsmanager:GetSecretValue` on `pyrmts-engine-batch-execution`, scoped to the two ARNs (or `ctbk/*`). (rev 17's role has no such policy — `secrets: []` today.)
3. **Seed the repointed revision** via a reusable ctbk subcommand (see below), dry-run first:
   `ctbk gbfs engine repoint --endpoint <HCCS> --access-key-arn <arn> --secret-key-arn <arn>` → registers `pyrmts-engine` rev 18 with the `secrets` block + HCCS endpoint, plaintext R2 env removed.
4. **Re-fill HCCS R2.** Re-run the fills that wrote to RAC:
   - `ctbk gbfs rides-v5-extend 202608` (submits to Batch on the new rev)
   - smg-v1 nightly fill (same job def; picks up rev 18 automatically)
5. **Verify:** HCCS manifest timestamp advances past 2026-09-10; HCCS api worker serves 202608 rides-v5 + avail without dangling refs; RAC manifest stops advancing.

### New CLI subcommand (reusable, not ad-hoc)

`ctbk gbfs engine repoint` in `gbfs_cli.py`, sibling to `jobdef`: reads latest `pyrmts-engine` revision, moves named env keys into `secrets` (by ARN), overrides `R2_ENDPOINT_URL`, registers a new revision. Re-runnable if ARNs rotate. Keeps the op one reviewable command (per the "prefer CLI subcommands" rule) rather than a hand-built `register-job-definition` JSON. After it seeds rev 18, ordinary `gbfs engine jobdef IMAGE` copies the `secrets`+HCCS shape forward on every future image bump.

## Phase B — fold into Pulumi (tracked, = `iac-finish-the-stack.md` Increment 1 → 2)

Not this change. Once the CI loop (Increment 1) exists, add the `pyrmts-engine` job def to `infra/aws_reproc.py` alongside reproc, referencing `ctbk/r2-*` by ARN (values stay out of state) and the existing exec role. First `pulumi up` is a no-op diff; `gbfs engine repoint`/`jobdef` are then retired in favor of a Pulumi image config. This is the durable home for "everything Pulumi'd."

## Non-goals / deferred

- Migrating the reproc (`dvx` / `ctbk-reproc`) job def to HCCS — separate, on-demand, coherent-on-RAC today.
- Building the Pulumi CI loop (Increment 1) — its own work.
- The AWS account move (Lambda-quota-blocked).
