"""R2/S3-aware Storage factory for pyramid-cascade.

Shared by the CLI (main process) and the ProcessPool worker
(`_block_task`) so both build identically-configured `S3Storage`
instances. Falls back through the same chain as
`ctbk.avail_v3.r2_client()`:

  1. `R2_*` env vars (R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).
  2. Combined: `CLOUDFLARE_ACCOUNT_ID` env (→ endpoint) + `AWS_*` env (→ creds).
  3. AWS profile `cf` (resolved via `boto3.Session(profile_name='cf')`),
     whose `~/.aws/config` carries the R2 endpoint and `~/.aws/credentials`
     carries the 32-char R2 access key.

Without this, pyrmts' bare `S3Storage` only consults env vars and falls
through to the default AWS credential chain — which on hosts with both
AWS and R2 creds installed picks the 20-char AWS key and hits R2 with
`InvalidArgument: Credential access key has length 20, should be 32`.
"""
from __future__ import annotations

import os

from pyrmts.storage import S3Storage


def storage_from_cfg(storage_cfg: dict) -> S3Storage:
    """Build an `S3Storage` honoring R2 env vars or the `cf` AWS profile.

    Only `storage.type: s3` is supported.
    """
    typ = storage_cfg['type']
    if typ != 's3':
        raise ValueError(f"unsupported storage.type {typ!r}; only 's3' implemented")

    endpoint_url = (
        os.environ.get('R2_ENDPOINT_URL')
        or (
            f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com"
            if 'CLOUDFLARE_ACCOUNT_ID' in os.environ
            else None
        )
    )

    access_key = os.environ.get('R2_ACCESS_KEY_ID')
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY')

    # No R2 env creds → resolve the `cf` AWS profile via boto3.Session and
    # hand its access/secret to S3Storage. Mirrors ctbk.avail_v3.r2_client().
    # We intentionally do NOT fall back to AWS_* env vars: those are usually
    # 20-char AWS S3 keys, which R2 rejects with `InvalidArgument`.
    if not (access_key and secret_key):
        import boto3
        creds = boto3.Session(profile_name='cf').get_credentials()
        if creds is None:
            raise RuntimeError(
                "no R2 credentials: set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY "
                "in env, or configure `[cf]` profile in ~/.aws/credentials"
            )
        frozen = creds.get_frozen_credentials()
        access_key = frozen.access_key
        secret_key = frozen.secret_key

    return S3Storage(
        bucket=storage_cfg['bucket'],
        endpoint_url=endpoint_url,
        region_name='auto',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )
