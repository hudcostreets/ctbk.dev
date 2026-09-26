"""Cloudflare infrastructure for ctbk.dev.

Resources:
- R2 bucket `ctbk` (imported, already exists) + its CORS rules (`hccs` stack)
- D1 database for hot per-day GBFS availability data
- CF Queue receiving R2 event notifications for new per-minute JSONs
- R2 event notification: gbfs/status/*.json → Queue
"""

import os
import pulumi
import pulumi_cloudflare as cf

config = pulumi.Config()
account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or config.require_secret('cloudflare_account_id')

# ── R2 bucket (imported; created via dashboard 2026-04-06) ────────────
ctbk_bucket = cf.R2Bucket(
    'ctbk',
    account_id=account_id,
    name='ctbk',
    location='ENAM',  # Eastern North America
    opts=pulumi.ResourceOptions(
        import_=f'{account_id}/ctbk/default',
        protect=True,
    ),
)

# ── R2 bucket CORS (browser reads of `data.ctbk.dev`: hyparquet range
# requests need `Content-Range` / `Accept-Ranges` / `Content-Length`
# exposed). `R2BucketCors` doesn't support `pulumi import`: the first
# `up` PUTs these rules over the identical live ones (idempotent).
# `retain_on_delete` so a destroy/rename never strips CORS from the
# live bucket.
if config.get_bool('manage_r2_cors'):
    cf.R2BucketCors(
        'ctbk-cors',
        account_id=account_id,
        bucket_name=ctbk_bucket.name,
        rules=[
            cf.R2BucketCorsRuleArgs(
                allowed=cf.R2BucketCorsRuleAllowedArgs(
                    origins=['*'],
                    methods=['GET', 'HEAD'],
                    headers=['*'],
                ),
                expose_headers=['Accept-Ranges', 'Content-Encoding', 'Content-Length', 'ETag', 'Content-Range'],
                max_age_seconds=3600,
            ),
        ],
        opts=pulumi.ResourceOptions(protect=True, retain_on_delete=True),
    )

# ── D1 database for current-day GBFS availability ─────────────────────
gbfs_db = cf.D1Database(
    'ctbk-gbfs',
    account_id=account_id,
    name='ctbk-gbfs',
    # Explicit: pulumi-cloudflare ≥ 6.21 sends `read_replication: null` on
    # update when unset, which the D1 API rejects (400, code 7400).
    read_replication={'mode': 'disabled'},
)

# ── CF Queue: per-minute JSON write events from R2 ────────────────────
gbfs_events_queue = cf.Queue(
    'gbfs-status-events',
    account_id=account_id,
    queue_name='gbfs-status-events',
)

# ── R2 → Queue event notification for new per-minute JSONs ────────────
gbfs_event_notification = cf.R2BucketEventNotification(
    'gbfs-status-events-notification',
    account_id=account_id,
    bucket_name=ctbk_bucket.name,
    queue_id=gbfs_events_queue.queue_id,
    rules=[
        cf.R2BucketEventNotificationRuleArgs(
            actions=['PutObject'],
            prefix='gbfs/status/',
            suffix='.json',
        ),
        cf.R2BucketEventNotificationRuleArgs(
            actions=['PutObject'],
            prefix='gbfs/info/',
            suffix='.json',
        ),
    ],
)

# ── Outputs (for wrangler.toml / Worker bindings) ─────────────────────
pulumi.export('r2_bucket', ctbk_bucket.name)
pulumi.export('d1_database_id', gbfs_db.id)
pulumi.export('d1_database_name', gbfs_db.name)
pulumi.export('queue_id', gbfs_events_queue.queue_id)
pulumi.export('queue_name', gbfs_events_queue.queue_name)

# ── Workers (deployed via wrangler from gbfs/{worker,loader,api}/) ────
# Not managed by Pulumi (wrangler is authoritative for script content),
# but recorded here for documentation. Bindings in each wrangler.toml
# reference the Pulumi-provisioned resources above.
WORKERS = {
    'ctbk-gbfs-poller':  'gbfs/worker',  # cron */1 *: poll GBFS → R2
    'ctbk-gbfs-loader':  'gbfs/loader',  # queue consumer: R2 events → D1
    'ctbk-gbfs-api':     'gbfs/api',     # HTTP API: D1 reads, daily cleanup cron
}
pulumi.export('workers', WORKERS)


# ── HCCS AWS account (Lambda cascade, engine + trips-DAG Batch, GHA OIDC) — `hccs` stack ─
if config.get_bool('manage_hccs_aws'):
    import aws_hccs
    aws_hccs.provision()
