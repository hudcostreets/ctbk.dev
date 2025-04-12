import sys
from abc import ABC
from functools import wraps
from os.path import basename
from typing import Optional

import utz
from click import option, Group, argument
from utz import decos, YM, run
from utz.case import dash_case
from utz.cli import count

from ctbk.cli.base import ctbk, StableCommandOrder
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
            @count('-G', '--no-git', help="0x: `dvc add` and `git commit` created/modified `.dvc` files; 1x: `dvc add` but don't `git commit`; 2x: don't `dvc add` or `git commit`")
            def create(
                no_git: int,
                **kwargs,
            ):
                tasks = cls(**kwargs)
                tasks.create()
                if no_git < 2:
                    run('dvc', 'add', *[ child.url for child in tasks.children ])
                    if no_git < 1:
                        argv = sys.argv
                        ctbk, *args = argv
                        if basename(ctbk) == 'ctbk':
                            argv = ['ctbk', *args]
                        msg = f"`{' '.join(argv)}`"
                        run('git', 'commit', '-m', msg)

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
