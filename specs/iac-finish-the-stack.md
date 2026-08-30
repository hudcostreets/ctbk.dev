# Finish the ctbk infra stack (don't start a new one)

Status: proposed (2026-08-29). Companion to the pyrmts session's
`specs/pyrmts-iac-answer.md` / pyrmts `specs/iac-boundary.md`, which argued
the *shape*; this is the ctbk-side plan and the first increment is already
landed.

## The finding that frames everything

ctbk **already has Pulumi**: `infra/` is a live `pulumi-cloudflare` project
(`infra/__main__.py`, `specs/pulumi-cf-infra.md` behind it) declaring four
resources — the imported R2 bucket (`protect=True`), the `ctbk-gbfs` D1
database, the `gbfs-status-events` queue, and the R2→queue event notification.
Last touched **2026-04-12**.

Since then ctbk grew, imperatively, around that stalled stack: 3 avail Lambdas
(`ctbk-avail-cascade{,-v5}`, `-rebuild`), 3 EventBridge rules, 2 ECR repos, a
Batch job definition + compute environments, 6 Workers (its `WORKERS` dict
lists 3), and 2 custom domains. `pulumi up` needed a human to remember it from
a laptop; the imperative scripts run in CI on every push. The scripts won.

So the task is **not** "adopt IaC" — it's finish the stack that exists, and
close the gap that let it stall (nothing ran it). A half-adopted IaC layer is
worse than scripts because it implies coverage it doesn't have; `infra/` is
that sentence already true in the tree (its `WORKERS` dict is 3 of 6).

## Increment 0 — DONE (2026-08-29): drift detection, no state migration

The cheapest, highest-value slice, and it needs no Pulumi at all: *detect*
drift on the imperative resources so the stalled stack's blind spots become
visible.

- **D1 schema** — `gbfs.yml`'s `d1-schema` job runs `pyrmts-ops d1 verify` on
  the push that re-pins pyrmts (verifies the newly-pinned DDL matches prod).
  Read-only, scoped token (`ctbk-gha-d1-read`).
- **EventBridge schedules** — `infra-drift.yml`, daily cron, runs
  `pyrmts-ops aws verify` over the three avail rules incl. the retired-and-must-
  stay-DISABLED v3 rule. Its invoke-permission check is exactly what would have
  caught the avail-v6 tick outage; verified locally that it flags a wrong
  schedule expr and a re-enabled v3 rule (exit 1).

These are `verify`-shaped, so they're safe to run against prod forever and
graduate cleanly: whatever a later `pulumi up` would manage, the same `verify`
keeps checking.

## Increment 1 — import the AWS resources into Pulumi (no-op first diff)

Leverage pyrmts' new Pulumi component library (`32cb08e`, `95c17eb` — a
pyramid's cloud footprint as components, validated against real providers).
Per `iac-boundary.md`, the useful primitive is a pure `config → desired
resource set` function: read a pyramid YAML, emit {function, schedule, env,
bucket, database} — pyrmts owns the description, ctbk's program declares it.

Order (OA's stated sequence — import first, so the first `pulumi up` is a no-op
diff that just gives you drift detection):

1. Add an AWS provider to `infra/` alongside the CF one.
2. Import the live Lambdas, EventBridge rules (with the `enabled=False` v3 rule
   as a *declared* fact), ECR repos, and the Batch job definition. Match the
   imperative scripts' current output so the diff is empty.
3. Reconcile the two imperative deployers against the imported resources:
   `deploy-image.py` becomes the thing Pulumi manages, or is retired in favor
   of it. (`deploy.py` is already gone, `fb0dbd6a`.)

Only after the import is a clean no-op do the imperative scripts get retired —
never a flag-day rewrite.

## Increment 2 — make it run without being remembered

The four-months-unrun problem is a CI problem, and it recurs with any tool a
human must invoke by hand.

1. Move state off the committed local-file backend (the thing that made
   concurrent/CI runs awkward). Reuse OA's Pulumi GHA workflow (`pulumi-v1`)
   for PR diffs — `pulumi-cf-infra.md` already intended this; the `infra.yml`
   it drafts was never created.
2. Wire `infra.yml` to run `pulumi preview` on PRs and `pulumi up` on merge, so
   the stack converges on push like the worker deploys already do.
3. Fold the drift `verify`s (increment 0) into the same story: preview *is* a
   superset of verify, but keep the standalone verifies as the cheap, always-on
   floor until `pulumi up` actually owns each resource.

## Explicit non-goals

- A pyrmts-side IaC framework. pyrmts ships the `config → resources`
  description and the `verify` commands; the stack lives in the consumer
  (`iac-boundary.md`, OA's `cf-iac.md`). D1 *migrations* stay with the app
  (schema is not IaC'd).
- CF-side expansion beyond the four existing resources until the AWS import is
  green — one incomplete stack at a time.
- Re-bootstrapping Batch to 16 vCPU is a separate, one-line op (`pyrmts-engine
  batch bootstrap` via the CLI, now that the shadowed default is fixed
  upstream); it mutates the shared job definition and wants explicit sign-off,
  independent of this IaC work.
