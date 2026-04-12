# Spec: Pulumi for Cloudflare Infrastructure

## Problem

We're about to manage a growing set of Cloudflare resources for ctbk.dev:
- R2 bucket(s)
- Workers (poller, D1 loader, API, possibly more)
- D1 database(s)
- Cloudflare Queue(s)
- R2 → Queue event notifications

So far the poller and R2 bucket have been created via the dashboard / wrangler. To avoid clicking around in the dashboard for new resources and to make the topology reproducible, we should manage CF infra as code.

## Goal

Use Pulumi (Python) to declaratively manage CF infrastructure for ctbk. Reuse Open-Athena's Pulumi GHA workflow (`pulumi-v1`) for nice PR diffs and deployment.

## Stack choice: Pulumi vs SST

- **Pulumi**: more general-purpose, broader provider ecosystem (CF, AWS, GCP), Ryan already knows it (uses at dayjob)
- **SST**: AWS-optimized, less mature CF support
- **Decision**: Pulumi, since CF is the primary target here and Pulumi's CF provider is mature

## Backend choice: local file in git

Use Pulumi's local file backend, with state files committed to git:

```
infra/
  Pulumi.yaml                    # backend: file://./state
  Pulumi.dev.yaml                # stack config
  __main__.py                    # resource definitions
  state/
    .pulumi/stacks/dev.json      # encrypted with PULUMI_CONFIG_PASSPHRASE
```

Pros:
- No external state bucket to manage
- State changes show up in PRs as diffs
- Encrypted (passphrase-based), so secrets stay safe
- Plays well with `live-branch` machinery from Open-Athena's pulumi-v1

Cons:
- Concurrent runs need locking — `live-branch` handles this if needed
- Solo project, low concurrency, so probably fine without `live-branch` initially

## Reuse: Open-Athena/pulumi-v1 GHA workflow

The `Open-Athena/pulumi/.github/workflows/pulumi.yml@v1` reusable workflow provides:
- `--patch` diff format for GitHub-friendly PR comments
- AWS OIDC auth (optional)
- GCP auth (optional, skipped when vars not set)
- Pulumi Cloud token (optional)
- `PULUMI_CONFIG_PASSPHRASE` for self-managed backends
- `live-branch` for monotonic deployment tracking (optional)

For ctbk: pass only `PULUMI_CONFIG_PASSPHRASE` + CF API token. Skip GCP/AWS auth.

## What to manage

### Phase 1: import existing + add D1/Queue
- **R2 bucket `ctbk`**: import existing
- **R2 event notification** on `gbfs/status/*.json` → Queue
- **CF Queue `gbfs-status-events`**
- **D1 database `ctbk-gbfs`**
- **API token** (separate, scoped to these resources only)

### Phase 2: bring Workers under Pulumi
- Poller Worker (currently wrangler-deployed)
- D1 loader Worker (Queue consumer)
- API Worker

Pulumi defines Worker bindings (R2 binding, D1 binding, Queue binding). Wrangler deploys Worker code on push. Wrangler.toml references resource names that Pulumi provisioned.

### Phase 3: optional
- `live-branch` for deployment tracking
- Multiple stacks (dev/prod) if needed
- Cloudflare Pages (if we move ctbk.dev hosting from GH Pages to CF Pages)

## Project structure

```
infra/
  Pulumi.yaml
  Pulumi.dev.yaml
  __main__.py                    # main Pulumi program
  resources/
    r2.py                        # R2 buckets, event notifications
    d1.py                        # D1 databases
    queues.py                    # CF Queues
    workers.py                   # Worker bindings (Phase 2)
  state/                         # local backend state, committed
    .pulumi/...
  README.md                      # how to run pulumi up locally
```

## GHA integration

Add `.github/workflows/infra.yml`:

```yaml
name: Infra
on:
  push:
    branches: [main]
    paths: ['infra/**']
  pull_request:
    paths: ['infra/**']
  workflow_dispatch:
    inputs:
      cmd:
        type: choice
        options: [preview, up, refresh]
      stack:
        default: dev

jobs:
  pulumi:
    uses: Open-Athena/pulumi/.github/workflows/pulumi.yml@v1
    with:
      cmd: ${{ inputs.cmd || (github.event_name == 'pull_request' && 'preview' || 'up') }}
      stack: ${{ inputs.stack || 'dev' }}
      working-directory: infra
    secrets: inherit
```

Required GH secrets:
- `PULUMI_CONFIG_PASSPHRASE` (already set)
- `CLOUDFLARE_API_TOKEN` (already set; needs scope for R2/D1/Queues/Workers)

## Open Questions

- Use Pulumi's CF provider directly, or wrap with reusable components for our patterns?
- Whether to import the existing `ctbk-gbfs-poller` Worker now or leave it wrangler-managed indefinitely
- Whether to use Pulumi Stack Outputs to feed Worker bindings into wrangler.toml (or just hardcode names that Pulumi provisions)
