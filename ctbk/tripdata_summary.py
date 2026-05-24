"""Emit a small JSON summary of `s3://tripdata` for the health page.

Listed-once, uploaded-once: `tripdata.yml` runs this, pipes the JSON to
R2 at `tripdata/latest.json`, and the worker reads it via its R2
binding (no need to grant the worker S3 access to the tripdata bucket).
"""
import json
import re
import sys
from datetime import datetime, timezone

from click import option
from utz.s3 import client

from ctbk.cli.base import ctbk

BKT = 'tripdata'
MONTH_RE = re.compile(r'\b(20\d{4})\b')


@ctbk.command('tripdata-summary', help="Emit `tripdata/latest.json` summary to stdout.")
@option('-o', '--output', help="Write to file (default: stdout)")
def tripdata_summary(output: str | None):
    """List `s3://tripdata` and emit a JSON summary."""
    s3 = client()
    paginator = s3.get_paginator('list_objects_v2')
    zips = []
    for page in paginator.paginate(Bucket=BKT):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key.endswith('.zip'):
                zips.append(key)

    # Sort by extracted YYYYMM (ascending), tiebreak by key. Files
    # without a parseable month sort to the front so the "latest" pick
    # is unambiguous even if there's noise in the bucket.
    def month_of(key: str) -> str:
        m = MONTH_RE.findall(key)
        return m[-1] if m else ''
    zips.sort(key=lambda k: (month_of(k), k))

    months = sorted({m for k in zips for m in MONTH_RE.findall(k)})
    latest_month = months[-1] if months else None
    latest_zip = zips[-1] if zips else None

    summary = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'latest_zip': latest_zip,
        'latest_month': latest_month,
        'recent_months': months[-12:],
        'total_zips': len(zips),
    }

    out = json.dumps(summary, indent=2) + '\n'
    if output:
        with open(output, 'w') as f:
            f.write(out)
    else:
        sys.stdout.write(out)
