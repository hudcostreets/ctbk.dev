# avail-v3 auto-rebuild: denorm-change detection + GHA execution

## Motivation

Denorm (`station-luc.json`) changes currently require a human to
notice, coordinate a rebuild on `e`, and sequence the R2 upload / D1
apply — a multi-hour, two-session dance (see
`specs/avail-v3-ladder-view-split.md` for how the 2026-07 one went).
Any denorm change that moves a station's LUC makes pyramid data for
that station wrong until a rebuild happens, so this is a correctness
loop, not an optimization: **detect → rebuild → verify → notify**,
unattended.

## Trigger + decision

Daily GHA cron (+ `workflow_dispatch` for manual runs):

1. `ctbk station-luc-build -R` (local only, no upload).
2. Compare md5 vs R2 `station-luc.json`.
   - Same → exit 0 (quiet; no Slack).
   - Different → proceed. There is no "too small to matter"
     threshold: any changed station's per-station queries are wrong
     until re-keyed. Thresholds only pick WHICH remedy:
     `ctbk station-luc-diff` (see `specs/avail-v3-delta-patch.md`)
     decides patch vs full rebuild once that tool exists; until then,
     always full rebuild.

## Execution

```yaml
concurrency: {group: avail-v3-rebuild, cancel-in-progress: false}
jobs:
  rebuild:
    runs-on: ubuntu-latest-64core        # or standard runner + `erz`'d EC2 via SSH
    timeout-minutes: 240
    steps:
      - checkout + `pip install -e .` + secrets (R2 keys, COMPACTOR_SECRET, CF token)
      - Slack post → capture thread `ts`                     # kickoff
      - upload denorm: `ctbk gbfs r2 put ... station-luc.json`
        + `... gbfs/station-luc.json` (server-side copy current →
        `station-luc.prev.json` first, per delta-patch spec)
      - REBUILD:
          ctbk pyramid-cascade -c configs/pyramids/avail.yaml \
              -M -B "$DENORM_UPLOAD_TS" \
              -r 2026-04-07/$(date -u -d tomorrow +%F) \
              --fsck --fill -w <sized-to-runner-RAM>
      - D1: wrangler d1 execute ctbk-gbfs --remote --file tmp/fsck-d1-record.sql
      - VERIFY: rerun fsck (no --fill) → assert 0 non-pre-genesis gaps;
        CFW /avail3?dryRun=1 → record totalMissing/stats
      - Slack reply in thread: wall time, shards written per rung,
        verify results                                        # done
      - on failure: Slack reply in thread with the failing step + log tail
```

Notes:

- **`-M -B` is the load-bearing pair** — the merged ladder matches
  the GC's view (nothing built gets reaped), and `stale-before` set
  to the denorm-upload timestamp rebuilds exactly the stale content
  in place, no delete window (see ladder-view-split spec).
- **Runner sizing**: `-w 3` needs ~45 GB peak (3× a /1m@2d-from-raw
  build); GH 64-core runners have 256 GB → `-w 6`+ fine. A standard
  4-core runner works at `-w 1` but takes ~4-5 h (still < timeout,
  still unattended — acceptable fallback if large-runner spend is a
  concern; the runs are rare).
- **R2 egress is free and not AWS-region-pinned**, so GH-hosted
  runners have no data-locality penalty vs EC2 — only the per-minute
  compute premium (~1.6×), on a workflow expected to fire a few
  times a year.
- **Slack**: `slackapi/slack-github-action`; kickoff message +
  threaded completion/failure reply so each rebuild is one thread.
- Once `avail-v3-patch` lands, insert the decision rule from the
  delta-patch spec between detect and rebuild; the patch path should
  bring the common case (a handful of churned stations) to <15 min
  on a standard runner.

## Provenance

After a successful run, the workflow commits (to a `data`-ish branch
or main, TBD):

- `specs/avail-v3-rebuilds.log.md` append: date, denorm md5 old→new,
  churn counts (from `station-luc-diff` when available), shard
  counts, wall time.
- Optionally a `.dvc`-style provenance stub recording
  `{denorm_md5, range_end, config_md5}` → the git history becomes the
  rebuild audit log and `dvx status`-style staleness oracle. The
  pyramid outputs themselves stay R2-canonical (DVC doesn't transport
  them; the CFW cascade + Lambda GC are co-writers, so DVC can't own
  the outputs — provenance-only).

## Prereqs / blockers

1. Secrets in GH: R2 access key pair, `COMPACTOR_SECRET`,
   Cloudflare API token for `wrangler d1 execute`. All exist for the
   ingest workflows except the CF token — add as repo secret.
2. `station-luc-build` needs its inputs (GBFS info snapshots,
   station-history.parquet) fetchable from a runner: they're on
   R2/S3 already (`dvc pull` for the S3 ones) — verify no `e`-local
   paths are baked in.
3. Decide the runner tier (64-core large runner vs standard+slow vs
   SSH-to-`erz`'d-EC2). Recommendation: standard runner + `-w 1` to
   start (zero new infra, unattended anyway), upgrade if the ~4 h
   wall time ever bites.
