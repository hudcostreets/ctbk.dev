from abc import ABC
from functools import cache
from os.path import exists, splitext, basename
from tempfile import mkdtemp
from typing import Type

import pandas as pd
from pandas import DataFrame
from utz import Unset, err
from utz.ym import Monthy

from ctbk.task import Task
from ctbk.util.df import save
from ctbk.util.read import Read

Tables = dict[str, DataFrame]


class TablesDir(Task[Tables], ABC):
    def __init__(self, ym: Monthy, **kwargs):
        self.ym = ym
        super().__init__(**kwargs)

    def _dfs(self) -> Tables:
        raise NotImplementedError

    def _create(self, read: Read | None | Type[Unset] = Unset) -> Tables:
        return self.checkpoint()

    def paths(self) -> dict[str, str]:
        fs = self.fs
        paths = fs.glob(f'{self.url}/*_*.parquet')
        return { splitext(basename(path))[0]: path for path in paths }

    def read(self) -> Tables:
        paths = self.paths()
        return {
            name: pd.read_parquet(path)
            for name, path in paths.items()
        }

    @cache
    def dfs(self) -> Tables:
        return self.create()

    @property
    def checkpoint_kwargs(self):
        return dict()

    def checkpoint(self) -> Tables:
        url = self.url
        rmdir = False
        if not exists(url):
            self.fs.mkdirs(url)
            rmdir = True
        rm_paths = []
        try:
            _dfs = self._dfs()
            dfs = {}
            for name, df in _dfs.items():
                path = f'{url}/{name}.parquet'
                save(df, url=path, **self.checkpoint_kwargs)
                dfs[name] = df
            rmdir = False
            rm_paths = {
                name: path
                for name, path in self.paths().items()
                if name not in dfs
            }
            return dfs
        finally:
            if rmdir:
                err(f"Removing directory {url} after failed write")
                self.fs.rm(url, recursive=True)
            if rm_paths:
                tmpdir = mkdtemp()
                err(f"Moving untracked parquets to {tmpdir}: {rm_paths}")
                for name, path in rm_paths.items():
                    self.fs.mv(path, f'{tmpdir}/{name}.parquet')
