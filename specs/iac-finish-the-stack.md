# Finish the ctbk infra stack: all cloud resources under Pulumi

Status: proposed (2026-08-29, rev 2). Rev 2 adopts the explicit goal — **Pulumi covering every cloud resource, AWS and CF** — and reorders the increments (loop before breadth) after the finding that the stall was an automation gap, not a coverage gap. Companion to `s3-to-r2-migration.md` (the "where it serves" change) and the pyrmts session's `specs/pyrmts-iac-answer.md` / pyrmts `specs/iac-boundary.md` (which argued the shape). First increment is landed.

## The goal

Stand up ctbk's entire cloud footprint from scratch, get structured deltas (`preview`) on every change, and detect drift — for both AWS and CF. Reproducibility, review-able deltas, general IaC hygiene. One stack, no dashboard-clicking, no remembered-from-a-laptop steps.

## Two orthogonal axes (don't conflate them)

The infra work splits along two independent axes. Every resource has a position on each; a plan that mixes them thrashes.

- **Axis 1 — where it runs / serves (AWS vs CF).** About cost and blast radius. This is the S3→R2 migration (`s3-to-r2-migration.md`) and the fact that the site + all GBFS/avail storage already live on CF. Some things move; some can't.
- **Axis 2 — who manages it (Pulumi vs imperative scripts).** About reproducibility. This spec. Applies to a resource *regardless of which cloud it's on*.

The load-bearing consequence: **coverage ≠ migration.** The avail pyramid cascade **stays on AWS** — Workers can't run it (128 MB / CPU-time caps; Batch needs 16 vCPU) — but it should still be **Pulumi-managed**. "Pulumi covers everything" explicitly *includes* the AWS avail Lambdas / Batch / ECR even though they never move to CF.

## Current state (2026-08-29)

ctbk **already has Pulumi**: `infra/` is a live `pulumi-cloudflare` project declaring four CF resources — the imported R2 bucket (`protect=True`), the `ctbk-gbfs` D1 database, the `gbfs-status-events` queue, and the R2→queue event notification. Last touched **2026-04-12**.

Since then ctbk grew imperatively *around* that stalled stack:

| Resource | Cloud | Managed by | Axis-2 target |
|---|---|---|---|
| R2 bucket, D1, Queue, event notification | CF | **Pulumi** ✅ | keep |
| 7 Workers (poller, loader, compactor, api, cascade, +dev) | CF | wrangler | Pulumi owns bindings/routes/domains; **code stays wrangler** |
| 2 custom domains | CF | dashboard/wrangler | Pulumi |
| S3 bucket `ctbk` | AWS | imperative / DVC | Pulumi (bucket); **objects stay DVC** |
| 3 avail Lambdas (`ctbk-avail-cascade{,-v5}`, `-rebuild`) | AWS | `deploy-image.py` | Pulumi (via pyrmts components) |
| 3 EventBridge rules | AWS | scripts | Pulumi |
| 2 ECR repos | AWS | scripts | Pulumi |
| Batch job-def + compute envs | AWS | scripts | Pulumi |

`pulumi up` needed a human to remember it from a laptop; the imperative scripts run in CI on every push. **The scripts won.** The `WORKERS` dict in `infra/__main__.py` lists 3 of 6 — a half-adopted layer that implies coverage it doesn't have.

## The finding that reorders everything

The stall was **not** a coverage gap — it was an **automation gap**. `infra/` didn't fall behind because it covered too little; it fell behind because **nothing ran it**. A bigger stalled stack is *worse* than scripts: it implies coverage it lacks, and the imperative scripts silently diverge from it.

So the binding constraint is "the stack runs itself on push," not "the stack is broad." Build the loop first, then widen — coverage is cheap once the loop exists, and dangerous without it.

## Scope boundary (what keeps "everything" finite)

Pulumi owns **infra resources**. It explicitly does **not** own:

- **Worker code** → `wrangler deploy` stays authoritative for script content. Pulumi owns bindings, routes, custom domains — not the code.
- **Bucket object contents** → DVC owns the objects in `ctbk` (S3 today, R2 after `s3-to-r2-migration.md`). Pulumi owns the bucket, not what's in it.
- **D1 schema / migrations** → app-owned (already checked by `pyrmts-ops d1 verify`). Schema is not IaC.

These three staying with their current owners is what makes "cover everything" a finite, reachable target rather than an ever-receding one.

## Increments (reordered: loop before breadth)

### Increment 0 — DONE (2026-08-29): drift detection, no state migration

The cheapest, highest-value slice; needs no Pulumi. *Detect* drift on the imperative resources so the stalled stack's blind spots become visible.

- **D1 schema** — `gbfs.yml`'s `d1-schema` job runs `pyrmts-ops d1 verify` on the pyrmts-repin push. Read-only, scoped token (`ctbk-gha-d1-read`).
- **EventBridge schedules** — `infra-drift.yml`, daily cron, runs `pyrmts-ops aws verify` over the three avail rules (incl. the retired-and-must-stay-DISABLED v3 rule). Its invoke-permission check is exactly what would have caught the avail-v6 tick outage; verified it flags a wrong schedule expr and a re-enabled v3 rule (exit 1). Green as of `Infra drift #33288976149`.

`verify`-shaped, so safe against prod forever and they graduate cleanly: whatever a later `pulumi up` manages, the same `verify` keeps checking as the always-on floor.

### Increment 1 — make the existing stack run itself in CI (the loop)

Before adding a single resource, get the **four resources already in Pulumi** converging on push. This is the piece whose absence caused the stall, proven on the cheapest, safest subset.

1. Move state off the committed local-file backend (`backend.url: file://./state`) — the thing that made concurrent/CI runs awkward. Reuse OA's Pulumi GHA workflow (`pulumi-v1`); pass `PULUMI_CONFIG_PASSPHRASE` + CF token.
2. Create `infra.yml` (drafted in `pulumi-cf-infra.md`, never built): `pulumi preview` on PRs, `pulumi up` on merge. The stack now converges on push like the worker deploys already do.
3. Prove a real delta flows through it (e.g. add the `data.ctbk.dev` R2 custom domain from `s3-to-r2-migration.md` step 0 *through Pulumi* — first real use of the loop).

### Increment 2 — widen coverage: import everything else (no-op first diff)

Only once the loop exists. Each import matched to the imperative scripts' current output so the first diff is empty; imperative scripts retired only after their resource imports clean.

- **AWS provider** added to `infra/` alongside CF. Leverage pyrmts' Pulumi component library (`32cb08e`, `95c17eb`): the useful primitive is a pure `config → desired resource set` — read a pyramid YAML, emit {function, schedule, env, bucket, database}. pyrmts owns the *description*; ctbk's program *declares* it (`iac-boundary.md`). So importing the avail Lambdas/EventBridge/Batch is calling pyrmts components, not bespoke ctbk code.
- Import order (OA's sequence — import first, so the first `pulumi up` is a no-op diff that just adds drift detection): Lambdas → EventBridge rules (with the `enabled=False` v3 rule as a *declared* fact) → ECR → Batch job-def → CF Workers' bindings/routes/domains → the S3/R2 bucket's account-level config.
- Reconcile the imperative deployers: `deploy-image.py` becomes the thing Pulumi manages, or is retired for it (`deploy.py` already gone, `fb0dbd6a`).
- Fold the Increment-0 `verify`s into the same story: `preview` is a superset of `verify`, but keep the standalone verifies as the cheap always-on floor until `pulumi up` actually owns each resource.

## Explicit non-goals

- A pyrmts-side IaC framework. pyrmts ships the `config → resources` description + the `verify` commands; the stack lives in the consumer (`iac-boundary.md`, OA's `cf-iac.md`).
- The three scope-boundary exclusions above (worker code, bucket objects, D1 schema).
- CF-side expansion beyond the existing resources until the AWS import is green — one incomplete stack at a time.
- Re-bootstrapping Batch to 16 vCPU: a separate one-line op (`pyrmts-engine batch bootstrap`); it mutates the shared job definition and wants explicit sign-off, independent of this work. (Pulumi *can* own the job-def; the vCPU value change is still a deliberate op.)

## The one half-migrated seam worth naming

The avail cascade is the last **compute** on AWS while its **data** is on R2 (a genuine Axis-1 split, forced by CFW limits, likely permanent). It is *not* a to-do — it's a documented decision: keep on Lambda/Batch, Pulumi-manage it there. The dormant `ctbk-gbfs-cascade` CF Worker (cron disabled) is the abandoned attempt to close that seam; leave it dormant unless CFW limits change.
