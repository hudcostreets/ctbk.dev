"""Cloudflare infrastructure for ctbk.dev.

Resources:
- R2 bucket `ctbk` (imported, already exists)
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

# ── D1 database for current-day GBFS availability ─────────────────────
gbfs_db = cf.D1Database(
    'ctbk-gbfs',
    account_id=account_id,
    name='ctbk-gbfs',
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
