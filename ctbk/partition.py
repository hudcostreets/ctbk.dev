from glob import glob
from os import makedirs
from os.path import dirname, exists
from pathlib import Path

import click
import pandas as pd
from utz import YM, err

from ctbk.cli.base import ctbk
from ctbk.has_root_cli import yms_arg
from ctbk.normalized import normalize_df

V0_DIR = 's3/ctbk/normalized/v0'


V0_START = YM(202001)
V0_END = YM(202101)


def get_v0_yms() -> list[YM]:
    """Get months that need v0 partition (202001-202101 only).

    Only these months use v0 data for backfilling Gender/Birth Year/Bike ID.
    """
    return list(V0_START.until(V0_END + 1))


@ctbk.group('partition', invoke_without_command=True)
@click.pass_context
def partition_group(ctx):
    """Separate pre-2024 parquets (`normalized/v0`) by {src,start,end} months."""
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


@partition_group.command('run')
@yms_arg
def partition_run(yms: list[YM]):
    """Execute partition for given months."""
    if not yms:
        yms = get_v0_yms()
    for ym in yms:
        pqt_path = f'{V0_DIR}/{ym}.parquet'
        ym_dir = f'{V0_DIR}/{ym}'
        ym_df = pd.read_parquet(pqt_path)
        dfs = normalize_df(ym_df, src=pqt_path)
        for yms_str, df in dfs.items():
            out_path = f'{ym_dir}/{yms_str}.parquet'
            out_dir = dirname(out_path)
            makedirs(out_dir, exist_ok=True)
            df.to_parquet(out_path, index=False)
            err(f"Wrote {len(df)} rows to {out_path}")


@partition_group.command('prep')
@click.argument('ym_ranges_str', required=False)
def partition_prep(ym_ranges_str: str | None):
    """Generate .dvc specs with computation provenance (DVX prep phase).

    Only processes 202001-202101 by default (months that use v0 for backfilling).
    """
    from ctbk.util.ym import parse_ym_ranges_str
    from dvx.run.artifact import Artifact, Computation
    from dvx.run.dvc_files import get_git_head_sha

    if ym_ranges_str:
        yms = parse_ym_ranges_str(ym_ranges_str, default_start=V0_START, default_end=V0_END + 1)
    else:
        yms = get_v0_yms()

    code_ref = get_git_head_sha()

    for ym in yms:
        pqt_path = f'{V0_DIR}/{ym}.parquet'
        ym_dir = f'{V0_DIR}/{ym}'

        # Input dep: the v0 parquet
        dep_artifact = Artifact.from_dvc(pqt_path)
        if dep_artifact is None:
            err(f"Warning: No .dvc file for {pqt_path}, skipping")
            continue

        # Output: the directory
        computation = Computation(
            cmd=f"ctbk partition run {ym}",
            code_ref=code_ref,
            deps=[dep_artifact],
        )

        artifact = Artifact(
            path=ym_dir,
            computation=computation,
        )

        dvc_path = artifact.write_dvc()
        err(f"Wrote {dvc_path}")
