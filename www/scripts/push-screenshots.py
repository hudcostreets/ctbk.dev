#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3", "click", "pyyaml"]
# ///
"""Publish regenerated screenshots to the DVX CA store + refresh pointers.

Counterpart of `fetch-screenshots.js` (`specs/www-screenshots-dvx.md`):
for each image under `public/screenshots/`, if its md5 differs from its
`.dvc` pointer, upload the blob to `s3://ctbk/.dvc/files/md5/…` and
rewrite the pointer (hand-rolled — no dvc CLI needed in CI). Then record
the regen's input deps in `.deps.json` (the data clock + www tree hash
that `www.yml`'s dep-gate compares against).

Run after `scrns`/Docker regen — in CI (`www.yml`) or locally.
"""
import hashlib
import json
import sys
from functools import partial
from pathlib import Path

import boto3
import yaml
from click import command, option

err = partial(print, file=sys.stderr)

DIR = Path(__file__).parent.parent / 'public/screenshots'
BUCKET = 'ctbk'
CA_PREFIX = '.dvc/files/md5'
EXTS = {'.png', '.jpg'}


@command()
@option('-d', '--data-md5', required=True, help='ymdgtb.dvc md5 (the monthly data clock) to record in .deps.json.')
@option('-n', '--dry-run', is_flag=True, help='Report changes; upload and write nothing.')
@option('-t', '--www-tree', required=True, help='www/ tree hash (screenshots-dir excluded) to record in .deps.json.')
def main(
    data_md5: str,
    dry_run: bool,
    www_tree: str,
) -> None:
    s3 = None if dry_run else boto3.client('s3')
    changed = 0
    for img in sorted(p for p in DIR.iterdir() if p.suffix in EXTS):
        body = img.read_bytes()
        md5 = hashlib.md5(body).hexdigest()
        dvc_path = img.with_name(img.name + '.dvc')
        prev = yaml.safe_load(dvc_path.read_text())['outs'][0]['md5'] if dvc_path.exists() else None
        if md5 == prev:
            continue
        changed += 1
        err(f'{img.name}: {prev or "(new)"} -> {md5} ({len(body):,} B)')
        if dry_run:
            continue
        s3.put_object(Bucket=BUCKET, Key=f'{CA_PREFIX}/{md5[:2]}/{md5[2:]}', Body=body)
        dvc_path.write_text(yaml.safe_dump({
            'outs': [{'md5': md5, 'size': len(body), 'hash': 'md5', 'path': img.name}],
        }, sort_keys=False))
    deps = {'ymdgtb_md5': data_md5, 'www_tree': www_tree}
    if not dry_run:
        (DIR / '.deps.json').write_text(json.dumps(deps, indent=2) + '\n')
    err(f'{changed} image(s) changed; deps recorded: {deps}')


if __name__ == '__main__':
    main()
