import sys
from abc import ABC
from functools import wraps
from os.path import basename
from typing import Optional

import utz
from click import option, Group, argument
from utz import decos, YM, err
from utz.case import dash_case

from ctbk.cli.base import ctbk, StableCommandOrder
from ctbk.cli.workflow import Workflow, workflow_option, run_workflow
from ctbk.task import Task
from ctbk.tasks import Tasks
from ctbk.util import GENESIS
from ctbk.util.ym import parse_ym_ranges_str

_default_end = None
def default_end():
    """Infer the last available month of data by checking which Tripdata Zips are present."""
    global _default_end
    if not _default_end:
        from ctbk.zips import TripdataZips

        yms = list(GENESIS.until(YM()))
        zips = TripdataZips(yms=yms)
        _default_end = zips.end
    return _default_end


def yms_param(deco):
    def wrapper(fn):
        @deco
        @wraps(fn)
        def _fn(*args, ym_ranges_str: str | None, **kwargs):
            yms = parse_ym_ranges_str(
                ym_ranges_str,
                default_start=GENESIS,
                default_end=default_end,
            )
            return fn(*args, yms=yms, **kwargs)

        return _fn

    return wrapper


yms_opt = yms_param(option('-d', '--dates', 'ym_ranges_str', help="Start and end dates in the format 'YYYY-MM'"))
yms_arg = yms_param(argument('ym_ranges_str', required=False))


class HasRootCLI(Tasks, ABC):
    ROOT_DECOS = []
    CHILD_CLS: type[Task] = None

    @classmethod
    def names(cls):
        return cls.CHILD_CLS.NAMES

    @classmethod
    def name(cls):
        return cls.names()[0]

    @classmethod
    def init_cli(
        cls,
        group: Group,
        cmd_decos: list = None,
        create_decos: list = None,
        group_cls: type[Group] = None,
        urls: bool = True,
        create: bool = True,
        prep: bool = True,
        dvx_run: bool = True,
    ):
        cmd_decos = cmd_decos or []

        def cmd(help):
            return decos(
                group.command(cls=group_cls, help=help),
                *cmd_decos
            )

        if urls:
            @cmd(help="Print URLs for selected datasets")
            def urls(**kwargs):
                tasks = cls(**kwargs)
                children = tasks.children
                for child in children:
                    print(child.url)

        if create:
            @cmd(help="Create selected datasets")
            @decos(create_decos or [])
            @workflow_option
            def create(
                workflow: int,
                **kwargs,
            ):
                tasks = cls(**kwargs)
                tasks.create()

                # Build commit message from command line
                argv = sys.argv
                ctbk_cmd, *args = argv
                if basename(ctbk_cmd) == 'ctbk':
                    argv = ['ctbk', *args]
                commit_msg = f"`{' '.join(argv)}`"

                # Run workflow steps, recording provenance (cmd + deps) so
                # create-path .dvc files stay reproc-eligible (not bare `dvx add`).
                artifacts = [child.to_artifact() for child in tasks.children]
                paths = [child.url for child in tasks.children]
                run_workflow(paths, workflow, commit_msg, artifacts=artifacts)

        if prep:
            @cmd(help="Generate .dvc specs with computation provenance (DVX prep phase)")
            @decos(create_decos or [])
            def prep(**kwargs):
                tasks = cls(**kwargs)
                children = tasks.children
                for child in children:
                    artifact = child.to_artifact()
                    dvc_path = artifact.write_dvc()
                    err(f"Wrote {dvc_path}")

        if dvx_run:
            @group.command('run', cls=group_cls, help="Execute stale computations via DVX (run phase)")
            @decos(cmd_decos)
            @decos(create_decos or [])
            @option('-n', '--dry-run', is_flag=True, help="Show what would be executed without running")
            @option('-f', '--force', is_flag=True, help="Force re-run even if fresh")
            @option('-j', '--jobs', type=int, default=1, help="Number of parallel jobs (-1 for CPU count)")
            @workflow_option
            def run_cmd(dry_run: bool, force: bool, jobs: int, workflow: int, **kwargs):
                from dvx.run.artifact import materialize

                tasks = cls(**kwargs)
                children = tasks.children
                artifacts = [child.to_artifact() for child in children]

                if dry_run:
                    from dvx.run.dvc_files import is_output_fresh
                    from pathlib import Path
                    for artifact in artifacts:
                        fresh, reason = is_output_fresh(Path(artifact.path))
                        status = "fresh" if fresh else f"stale ({reason})"
                        err(f"{artifact.path}: {status}")
                else:
                    # Level 0 = compute only (no .dvc update)
                    # Level 1+ = update .dvc files
                    update_dvc = workflow >= Workflow.ADD
                    computed = materialize(artifacts, force=force, parallel=jobs, update_dvc=update_dvc)

                    if computed:
                        err(f"Computed {len(computed)} artifact(s)")

                        # Run higher workflow levels (git add, commit, push, etc.)
                        if workflow >= Workflow.COMMIT:
                            argv = sys.argv
                            ctbk_cmd, *args = argv
                            if basename(ctbk_cmd) == 'ctbk':
                                argv = ['ctbk', *args]
                            commit_msg = f"`{' '.join(argv)}`"
                            paths = [a.path for a in computed]
                            run_workflow(paths, workflow, commit_msg, artifacts=computed)
                    else:
                        err("All artifacts are fresh")

    @classmethod
    def cli(
        cls,
        help: str,
        decos: Optional[list] = None,
        cmd_decos: Optional[list] = None,
        create_decos: Optional[list] = None,
        **kwargs
    ) -> Group:
        command_cls = cls.command_cls()
        decos = decos or []

        @utz.decos(
            ctbk.group(dash_case(cls.name()), cls=command_cls, help=help),
            *decos
        )
        def group():
            pass

        cls.init_cli(
            group,
            cmd_decos=cmd_decos,
            create_decos=create_decos,
            **kwargs,
        )
        return group

    @classmethod
    def command_cls(cls):
        class Command(StableCommandOrder):
            ALIASES = cls.names()

        return Command
