import re
from dataclasses import dataclass
from functools import wraps
from os.path import basename
from re import Pattern

from click import option, UsageError
import utz
from utz import err
from utz.cli import flag
from utz.s3 import get_etags

from ctbk.blob import Blob
from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd

BKT = 'tripdata'

@dataclass(init=False)
class Includes:
    pats: list[Pattern]

    def __init__(self, *pats: str | Pattern):
        self.pats = [
            re.compile(pat) if isinstance(pat, str) else pat
            for pat in pats
        ]

    def __call__(self, val: str) -> bool:
        return any(pat.search(val) for pat in self.pats)

    def __bool__(self) -> bool:
        return bool(self.pats)


@dataclass(init=False)
class Excludes(Includes):
    def __call__(self, val: str) -> bool:
        return not super().__call__(val)


Filters = Includes | Excludes | None


def filters(fn):
    @option('-x', '--include', 'includes', multiple=True, callback=lambda ctx, param, val: Includes(*val))
    @option('-X', '--exclude', 'excludes', multiple=True, callback=lambda ctx, param, val: Excludes(*val))
    @wraps(fn)
    def _fn(
        *args,
        includes: Includes = None,
        excludes: Excludes = None,
        **kwargs,
    ):
        if includes:
            if excludes:
                raise UsageError(f"Pass `-x/--include` xor `-X/--exclude`")
            filters = includes
        else:
            filters = excludes
        return fn(*args, filters=filters, **kwargs)

    return _fn


@ctbk.command('import')
@git_dvc_cmd
@flag('-v', '--verbose')
@filters
def import_zips(
    dry_run: bool,
    filters: Filters,
    verbose: bool,
) -> str | None:
    etags = get_etags(f's3://{BKT}/')
    updates = []
    for key, etag in etags.items():
        if not filters(key):
            err(f"Skipping {key}")
            continue
        blob = Blob(BKT, key)
        if blob.update(dry_run=dry_run, verbose=verbose):
            updates.append(key)

    staged_zips = [
        re.split(r'\s+', line, 1)[1]
        for line in utz.lines('git', 'status', '-s')
        if line[0] in 'AM' and line.endswith('.zip.dvc')
    ]
    if staged_zips:
        return f'Import {", ".join([ basename(path) for path in staged_zips ])}'
    else:
        return None
