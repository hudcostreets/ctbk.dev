from dataclasses import dataclass
from functools import wraps
from typing import Union

import pandas as pd
from utz.ym import Monthy

from ctbk.consolidated import ConsolidatedMonth
from ctbk.has_root_cli import HasRootCLI, yms_arg
from ctbk.month_table import MonthTable
from ctbk.tasks import MonthsTables
from ctbk.util import keys
from ctbk.util.constants import BKT
from ctbk.util.df import DataFrame

DIR = f'{BKT}/stations/meta_hists'


@dataclass
class GroupByKeys(keys.GroupByKeys):
    year: bool = False
    month: bool = False
    id: bool = False
    name: bool = False
    lat_lng: bool = False

    KEYS = {
        'year': 'y',
        'month': 'm',
        'id': 'i',
        'name': 'n',
        'lat_lng': 'l',
    }

    @classmethod
    def help(cls):
        return f'One or more keys to group station occurrences (taken from both ride starts and ends) by: {cls.char_name_summary()}'


class StationMetaHist(MonthTable):
    DIR = DIR
    NAMES = [ 'station_meta_hist', 'smh', ]

    def __init__(
            self,
            ym: Monthy,
            group_by_keys: Union[str, GroupByKeys, dict],
            **kwargs
    ):
        self.group_by_keys = GroupByKeys.load(group_by_keys)
        super().__init__(ym)

    @property
    def url(self) -> str:
        return f'{self.dir}/{self.group_by_keys.label}_{self.ym}.parquet'

    @property
    def cmd(self) -> str:
        return f"ctbk smh create -w0 -g {self.group_by_keys.label} {self.ym}"

    def dep_artifacts(self):
        from dvx.run.artifact import Artifact
        cons_path = f's3/ctbk/normalized/{self.ym}.parquet'
        artifact = Artifact.from_dvc(cons_path)
        return [artifact] if artifact else []

    def _df(self) -> DataFrame:
        src = ConsolidatedMonth(self.ym)
        df = src.read()
        # Assign each ride to its start YM, ignore the end time (except for the "duration" sum_key)
        df = df.rename(columns={
            'Start Year': 'year',
            'Start Month': 'month',
            'Start Time': 'time'
        })
        group_by_keys = dict(self.group_by_keys)
        group_by_cols = []
        if group_by_keys.get('y'):
            if 'year' not in df:
                df['year'] = df['time'].dt.year
            group_by_cols.append('year')
        if group_by_keys.get('m'):
            if 'month' not in df:
                df['month'] = df['time'].dt.month
            group_by_cols.append('month')

        # Below can be factored like this; can the above, and similar in `AggregatedMonth`?
        # COL_NAMES = {
        #     'i': { 'Station ID': 'id' },
        #     'n': { 'Station Name': 'name' },
        #     'l': {
        #         'Station Latitude': 'lat',
        #         'Station Longitude': 'lng',
        #     }
        # }
        #
        # col_names = {
        #     prv_col: new_col
        #     for key in dict(self.group_by_keys)
        #     for prv_col, new_col in COL_NAMES[key].items()
        # }

        col_names = {}
        if group_by_keys.get('i'):
            col_names['Station ID'] = 'id'
        if group_by_keys.get('n'):
            col_names['Station Name'] = 'name'
        if group_by_keys.get('l'):
            col_names['Station Latitude'] = 'lat'
            col_names['Station Longitude'] = 'lng'

        # Combine the names and lat/lngs for each station, from both ride starts and ride ends.
        # Histogram each one and then combine them below
        def starts_ends_hist(starts: bool):
            prefix = 'Start' if starts else 'End'
            renames = {
                f'{prefix} {cur_col}': new_col
                for cur_col, new_col in col_names.items()
            }
            cur_cols = group_by_cols + list(renames.keys())
            renamed = df[cur_cols].rename(columns=renames)
            grouped = renamed.groupby(renamed.columns.tolist())
            counts = (
                grouped
                .size()
                .rename('count')
                .reset_index()
            )
            return counts

        starts = starts_ends_hist(starts=True)
        ends = starts_ends_hist(starts=False)

        # Combine the `starts` and `ends` hists
        station_entries = pd.concat([starts, ends])
        cols = station_entries.columns.tolist()[:-1]
        stations_meta_hist = (
            station_entries
            .groupby(cols)
            ['count']
            .sum()
            .reset_index()
            .sort_values(cols)
        )
        return stations_meta_hist

    @property
    def save_kwargs(self):
        return dict(write_kwargs=dict(index=False))


class StationMetaHists(HasRootCLI, MonthsTables):
    DIR = DIR
    CHILD_CLS = StationMetaHist

    def __init__(self, group_by_keys: GroupByKeys, **kwargs):
        self.group_by_keys = group_by_keys
        super().__init__(**kwargs)

    def month(self, ym: Monthy) -> StationMetaHist:
        return StationMetaHist(ym, group_by_keys=self.group_by_keys, **self.kwargs)


def cmd(fn):
    @GroupByKeys.opt()
    @wraps(fn)
    def _fn(*args, group_by, **kwargs):
        group_by_keys = GroupByKeys.load(group_by)
        fn(*args, group_by_keys=group_by_keys, **kwargs)
    return _fn


StationMetaHists.cli(
    help=f"Aggregate station name, lat/lng info from ride start and end fields. Writes to <root>/{DIR}/KEYS_YYYYMM.parquet.",
    cmd_decos=[yms_arg, cmd],
)
