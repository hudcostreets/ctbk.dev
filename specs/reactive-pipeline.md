# Spec: Reactive Pipeline — Auto-trigger Ingest on New Data

## Problem

Currently, `tripdata.yml` imports new `.zip` files and commits `.dvc` tracking files, but the actual data processing pipeline (`ci.yml`) must be triggered manually via `workflow_dispatch`. This means new data sits unprocessed until someone notices and clicks the button.

## Goal

When `tripdata.yml` imports new data, automatically trigger `ci.yml` with the detected month, so the full pipeline (normalize → consolidate → aggregate → station modes → station pairs → JSON assets) runs without human intervention.

## Approach

### Phase 1: Auto-dispatch `ci.yml` from `tripdata.yml`

After a successful import, use [`workflow_dispatch`] to trigger the ingest pipeline:

```yaml
- name: Trigger ingest pipeline
  if: steps.sync.outputs.month != ''
  uses: actions/github-script@v7
  with:
    script: |
      await github.rest.actions.createWorkflowDispatch({
        owner: context.repo.owner,
        repo: context.repo.repo,
        workflow_id: 'ci.yml',
        ref: 'main',
        inputs: { ym: '${{ steps.sync.outputs.month }}' }
      })
```

This requires the `GITHUB_TOKEN` to have `actions: write` permission (add to `permissions:` block).

### Phase 2: S3 Event Notifications (realtime)

Instead of polling daily, react to S3 bucket changes in realtime:

**Option A: S3 → SNS → GitHub webhook**

1. Configure S3 Event Notifications on `s3://tripdata` for `s3:ObjectCreated:*` events
2. Route to an SNS topic
3. SNS subscriber is an HTTPS endpoint that triggers the GHA workflow via GitHub API

Challenges:
- `s3://tripdata` is Citi Bike's public bucket — we likely can't configure event notifications on it
- Would need our own polling mechanism regardless

**Option B: S3 → Lambda → GitHub API**

1. Lambda function polls `s3://tripdata` on a schedule (or via EventBridge)
2. Compares against known files (from a DynamoDB table or our own S3 state file)
3. When new files detected, calls GitHub API to dispatch `tripdata.yml`

This is essentially what we already do, just moved from GHA cron to Lambda. Not a clear win unless we want sub-daily latency.

**Option C: S3 Inventory + Change Detection (simplest realtime-ish)**

1. Enable S3 Inventory on our own mirror bucket
2. Periodically diff against `s3://tripdata` listing
3. Trigger on changes

**Recommendation**: Option A/B don't work because we can't configure events on Citi Bike's public bucket. Stick with the GHA cron schedule (Phase 1) — daily polling is fine since Citi Bike only publishes monthly.

### Phase 3: End-to-end pipeline orchestration

Make `ci.yml` also auto-trigger the `www.yml` deployment when it completes, so the full chain is:

```
tripdata.yml (daily poll)
  → detects new .zip
  → ci.yml (ingest pipeline)
    → www.yml (deploy updated site)
```

The `ci.yml` workflow's `ymrgtb_cd_json` and `station_urls_json` jobs already push to a `push-www` branch. Add a final job that triggers `www.yml` deployment, or configure `www.yml` to trigger on pushes to `push-www`.

## Dependencies

- [gha-job-summary spec](gha-job-summary.md) — needs `month` output from sync step
- [slack-notifications spec](slack-notifications.md) — notify at each stage

## Files Changed

| File | Change |
|------|--------|
| `.github/workflows/tripdata.yml` | Add auto-dispatch step, `actions: write` permission |
| `.github/workflows/ci.yml` | (Phase 3) Add final job to trigger www deployment |

## Considerations

- **Guard against duplicate runs**: If `tripdata.yml` imports multiple months at once (unlikely but possible), the `month` output detection should handle this. Could dispatch `ci.yml` once per month, or pass a comma-separated list.
- **Failure handling**: If `ci.yml` fails mid-pipeline, it should be safe to re-run (pipeline steps are idempotent). Slack notification on failure would help.
- **Rate of change**: Citi Bike publishes monthly, so daily polling with auto-dispatch is sufficient. Sub-hourly polling would be overkill.

[`workflow_dispatch`]: https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch
