# Spec: Slack Notifications for New Tripdata

## Problem

New Citi Bike tripdata appears monthly in `s3://tripdata`, usually around the 10th-15th of the following month. The `tripdata.yml` workflow polls daily and imports automatically, but nobody is notified when new data lands. You have to manually check the Actions page to know.

## Goal

Send a Slack notification when `tripdata.yml` finds and imports new data. The message should include:
- Which files were imported
- The detected month (e.g. "February 2026")
- A link to the GHA run
- A button/link to trigger the `ci.yml` ingest pipeline

No notification on no-op runs.

## Approach

### Option A: GitHub Actions Slack integration (recommended)

Use the [`slackapi/slack-github-action`] to post to a channel:

```yaml
- name: Notify Slack
  if: steps.sync.outputs.new_files != ''
  uses: slackapi/slack-github-action@v2
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      {
        "text": "New Citi Bike data imported: ${{ steps.sync.outputs.month }}",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*New Citi Bike tripdata imported* :bike:\n\nFiles: `${{ steps.sync.outputs.new_files }}`\nMonth: *${{ steps.sync.outputs.month }}*\n\n<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View run> · <${{ github.server_url }}/${{ github.repository }}/actions/workflows/ci.yml|Run ingest pipeline>"
            }
          }
        ]
      }
```

### Option B: Simple webhook curl

If you don't want to use the action:

```yaml
- name: Notify Slack
  if: steps.sync.outputs.new_files != ''
  run: |
    curl -X POST "${{ secrets.SLACK_WEBHOOK_URL }}" \
      -H 'Content-Type: application/json' \
      -d '{"text":"New Citi Bike data: ${{ steps.sync.outputs.month }} — ${{ steps.sync.outputs.new_files }}"}'
```

## Setup

1. Create a Slack app or incoming webhook for the target workspace/channel
2. Add the webhook URL as `SLACK_WEBHOOK_URL` in repo secrets
3. Add the notification step to `tripdata.yml` (after the sync step, conditional on `new_files`)

## Dependencies

- [gha-job-summary spec](gha-job-summary.md) — the `steps.sync.outputs.new_files` and `month` outputs need to exist first

## Files Changed

| File | Change |
|------|--------|
| `.github/workflows/tripdata.yml` | Add Slack notification step |

[`slackapi/slack-github-action`]: https://github.com/slackapi/slack-github-action
