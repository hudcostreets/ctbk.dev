#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3", "click", "pyyaml"]
# ///
"""Publish regenerated screenshots to their HR S3 home.

Counterpart of `fetch-screenshots.js` (`specs/www-screenshots-s3-hr.md`):
upload each image under `public/screenshots/` whose md5 differs from the
current manifest to `s3://ctbk/screenshots/<name>` (overwrite in place —
no versioning), then write a fresh `.deps.json` next to them recording
the regen's input deps (data clock + www tree hash, which `www.yml`'s
dep-gate compares against) plus the image manifest (names + md5s, which
`fetch-screenshots.js` downloads from).

Run after `scrns`/Docker regen — in CI (`www.yml`) or locally (both
`-d`/`-t` are auto-computed from the repo when omitted).
"""
import hashlib
import json
import subprocess
import sys
from functools import partial
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

import boto3
from click import command, option

err = partial(print, file=sys.stderr)

WWW = Path(__file__).parent.parent
DIR = WWW / 'public/screenshots'
DEFAULT_OUT = 's3://ctbk/screenshots'
EXTS = {'.png', '.jpg'}
CONTENT_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg'}


def auto_data_md5() -> str:
    import yaml
    dvc = WWW.parent / 's3/ctbk/stations/ymdgtb.dvc'
    return yaml.safe_load(dvc.read_text())['outs'][0]['md5']


def auto_www_tree() -> str:
    ls = subprocess.run(
        ['git', 'ls-files', '-s', '--', 'www', ':!www/public/screenshots'],
        cwd=WWW.parent, check=True, capture_output=True,
    ).stdout
    return subprocess.run(
        ['git', 'hash-object', '--stdin'],
        input=ls, check=True, capture_output=True,
    ).stdout.decode().strip()


@command()
@option('-d', '--data-md5', help='ymdgtb.dvc md5 (the monthly data clock) to record in .deps.json; default: read from the repo.')
@option('-n', '--dry-run', is_flag=True, help='Report changes; upload and write nothing.')
@option('-o', '--output', default=DEFAULT_OUT, help=f'Destination: s3://bucket/prefix or a local dir (default {DEFAULT_OUT}).')
@option('-t', '--www-tree', help='www/ tree hash (screenshots-dir excluded) to record in .deps.json; default: compute from the repo.')
def main(
    data_md5: str | None,
    dry_run: bool,
    output: str,
    www_tree: str | None,
) -> None:
    data_md5 = data_md5 or auto_data_md5()
    www_tree = www_tree or auto_www_tree()

    s3_dest = output.startswith('s3://')
    if s3_dest:
        u = urlparse(output)
        bucket, prefix = u.netloc, u.path.strip('/')
        s3 = boto3.client('s3')
        # Prior manifest (for skip-unchanged) via the public HTTPS URL —
        # absent on first bootstrap.
        try:
            with urlopen(f'https://{bucket}.s3.amazonaws.com/{prefix}/.deps.json') as r:
                prev_images = json.load(r).get('images', {})
        except Exception:
            prev_images = {}
    else:
        out_dir = Path(output)
        try:
            prev_images = json.loads((out_dir / '.deps.json').read_text()).get('images', {})
        except FileNotFoundError:
            prev_images = {}

    images = {}
    changed = 0
    for img in sorted(p for p in DIR.iterdir() if p.suffix in EXTS):
        body = img.read_bytes()
        md5 = hashlib.md5(body).hexdigest()
        images[img.name] = {'md5': md5, 'size': len(body)}
        prev = prev_images.get(img.name, {}).get('md5')
        if md5 == prev:
            continue
        changed += 1
        err(f'{img.name}: {prev or "(new)"} -> {md5} ({len(body):,} B)')
        if dry_run:
            continue
        if s3_dest:
            s3.put_object(
                Bucket=bucket,
                Key=f'{prefix}/{img.name}',
                Body=body,
                ContentType=CONTENT_TYPES[img.suffix],
            )
        else:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / img.name).write_bytes(body)
    deps = {'ymdgtb_md5': data_md5, 'www_tree': www_tree, 'images': images}
    if not dry_run:
        body = (json.dumps(deps, indent=2) + '\n').encode()
        if s3_dest:
            s3.put_object(Bucket=bucket, Key=f'{prefix}/.deps.json', Body=body, ContentType='application/json')
        else:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / '.deps.json').write_bytes(body)
    err(f'{changed}/{len(images)} image(s) changed -> {output}; deps: data {data_md5} tree {www_tree}')


if __name__ == '__main__':
    main()
