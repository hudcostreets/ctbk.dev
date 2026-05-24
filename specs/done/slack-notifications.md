# Spec: Slack Notifications

> Status: **done** (2026-05-23, commit TBD)

## Problem

Two events deserve real-time visibility instead of "click into the Actions UI":

1. **New tripdata lands.** `tripdata.yml` polls daily; most runs are no-ops.
   When new data appears (usually 10th–15th of each following month),
   nobody knows without manually checking GHA.
2. **Site deploys.** `www.yml` rebuilds + deploys `ctbk.dev` on push to
   `www` (most commonly: a new-month commit pushed by `ci.yml`). A
   visible "shipped" signal is useful both for confirmation and as a
   failure signal — if (1) fires but (2) doesn't follow within ~30 min,
   the ingest pipeline broke between import and deploy.

## Approach

Single Slack bot, channel `C0B5MKF28NP` (`#ctbk-bot`). Both workflows
call Slack `chat.postMessage` with `Authorization: Bearer
$SLACK_BOT_TOKEN`. Bot token gives a single GHA secret usable across
multiple call sites and channels; webhook-per-channel is more secrets
for the same surface.

Implementation: inline `python - <<'PY'` block using stdlib only
(`urllib.request`, `json`) — no third-party action, no extra deps.

## Pieces

### 1. `ctbk import` emits step outputs

`ctbk/import_zips.py` now writes `new_files` and `month` to
`$GITHUB_OUTPUT` (via the existing `step_output()` helper):

- `new_files` — comma-separated `.zip` basenames (no `.dvc` suffix)
- `month` — single `YYYYMM` if all imported files share one month, else empty

No-op runs emit empty strings (so the `if: steps.sync.outputs.new_files != ''`
gate works without `always()` gymnastics).

### 2. `tripdata.yml`

- Sync step gets `id: sync` so outputs are addressable
- "Job summary" step writes `$GITHUB_STEP_SUMMARY` — no-op vs imported visible at-a-glance
- "Notify Slack" step fires only when `new_files != ''`

### 3. `www.yml`

Post-deploy Slack notification, conditional on:
- `github.ref == 'refs/heads/www'` (skip the `scrns-playwright-test` branch)
- `steps.deploy.outcome == 'success'`
- `steps.smoke.outcome == 'success'` (added `id: smoke` to the smoke check)

Message includes commit short SHA, subject line, link to commit + run + ctbk.dev.

## Setup

Requires one GHA secret: `SLACK_BOT_TOKEN` (workspace bot with
`chat:write` scope on the target channel). Channel ID is hardcoded
(`C0B5MKF28NP`) — not secret, easier to grep.

```bash
gh secret set SLACK_BOT_TOKEN < /path/to/token
```

## Files Changed

| File | Change |
|------|--------|
| `ctbk/import_zips.py` | Emit `new_files` + `month` step outputs |
| `.github/workflows/tripdata.yml` | `id: sync`, job summary, Slack notify |
| `.github/workflows/www.yml` | `id: smoke`, Slack notify on deploy success |

## Notes / followups

- Redundancy is by design: tripdata-found + deploy-success are
  independently useful, and the absence of the deploy ping after a
  tripdata ping is itself a signal.
- Alerting on pipeline *failures* (per-minute GBFS scraper gaps,
  compaction lag, etc.) is a different beast — handled separately by
  a CFW cron (task #55).

[`chat.postMessage`]: https://api.slack.com/methods/chat.postMessage
