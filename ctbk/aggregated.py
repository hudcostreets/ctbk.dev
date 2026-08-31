from dataclasses import dataclass
from functools import wraps
from typing import Union

from utz import decos
from utz.ym import Monthy

from ctbk.consolidated import ConsolidatedMonth
from ctbk.has_root_cli import HasRootCLI, yms_arg
from ctbk.month_table import MonthTable
from ctbk.tasks import MonthsTables
from ctbk.util import keys
from ctbk.util.constants import BKT
from ctbk.util.df import DataFrame

DIR = f'{BKT}/aggregated'


@dataclass
class GroupByKeys(keys.GroupByKeys):
    year: bool = False
    month: bool = False
    day: bool = False
    weekday: bool = False
    hour: bool = False
    minute: bool = False
    region: bool = False
    gender: bool = False
    user_type: bool = False
    rideable_type: bool = False
    start_station: bool = False
    end_station: bool = False

    KEYS = {
        'year': 'y',
        'month': 'm',
        'day': 'd',
        'weekday': 'w',
        'hour': 'h',
        'minute': 'n',
        'region': 'r',
        'gender': 'g',
        'user_type': 't',
        'rideable_type': 'b',
        'start_station': 's',
        'end_station': 'e',
    }

    @classmethod
    def help(cls):
        return f'One or more keys to group rides by: {cls.char_name_summary()}'


@dataclass
class AggregateByKeys(keys.AggregateByKeys):
    count: bool = True
    duration: bool = False

    KEYS = {
        'count': 'c',
        'duration': 'd',
    }

    @classmethod
    def help(cls):
        return f'One or more keys to aggregate (sum) rides by: {cls.char_name_summary()}'


class AggregatedMonth(MonthTable):
    DIR = DIR
    NAMES = [ 'aggregated', 'agg', 'a', ]

    def __init__(
        self,
        ym: Monthy,
        group_by_keys: Union[str, GroupByKeys, dict],
        aggregate_by_keys: Union[str, AggregateByKeys, dict],
    ):
        self.group_by_keys = GroupByKeys.load(group_by_keys)
        self.aggregate_by_keys = AggregateByKeys.load(aggregate_by_keys)
        super().__init__(ym)

    @property
    def url(self):
        return f'{self.dir}/{self.group_by_keys.label}_{self.aggregate_by_keys.label}_{self.ym}.parquet'

    @property
    def cmd(self) -> str:
        return f"ctbk agg create -w0 -g {self.group_by_keys.label} -a {self.aggregate_by_keys.label} {self.ym}"

    def dep_artifacts(self):
        from dvx.run.artifact import Artifact
        cons_path = f's3/ctbk/normalized/{self.ym}.parquet'
        artifact = Artifact.from_dvc(cons_path)
        return [artifact] if artifact else []

    def _df(self) -> DataFrame:
        src = ConsolidatedMonth(self.ym)
        df = src.read()
        group_by_keys = dict(self.group_by_keys)
        aggregate_by_keys = dict(self.aggregate_by_keys)
        group_by_cols = []
        if group_by_keys.get('r'):
            df = df.rename(columns={'Start Region': 'Region'})  # assign rides to the region they originated in
            group_by_cols.append('Region')
        if group_by_keys.get('y'):
            if 'Start Year' not in df:
                df['Start Year'] = df['Start Time'].dt.year
            group_by_cols.append('Start Year')
        if group_by_keys.get('m'):
            if 'Start Month' not in df:
                df['Start Month'] = df['Start Time'].dt.month
            group_by_cols.append('Start Month')
        if group_by_keys.get('d'):
            if 'Start Day' not in df:
                df['Start Day'] = df['Start Time'].dt.day
            group_by_cols.append('Start Day')
        if group_by_keys.get('w'):
            if 'Start Weekday' not in df:
                df['Start Weekday'] = df['Start Time'].dt.weekday
            group_by_cols.append('Start Weekday')
        if group_by_keys.get('h'):
            if 'Start Hour' not in df:
                df['Start Hour'] = df['Start Time'].dt.hour
            group_by_cols.append('Start Hour')
        if group_by_keys.get('n'):
            if 'Start Minute' not in df:
                df['Start Minute'] = df['Start Time'].dt.minute
            group_by_cols.append('Start Minute')
        if group_by_keys.get('g'):
            group_by_cols.append('Gender')
        if group_by_keys.get('t'):
            group_by_cols.append('User Type')
        if group_by_keys.get('b'):
            group_by_cols.append('Rideable Type')
        if group_by_keys.get('s'):
            group_by_cols.append('Start Station ID')
        if group_by_keys.get('e'):
            group_by_cols.append('End Station ID')
        if group_by_keys.get('l'):
            group_by_cols += ['Start Station Latitude', 'Start Station Longitude']
        if group_by_keys.get('L'):
            group_by_cols += ['End Station Latitude', 'End Station Longitude']

        aggregate_by_cols = []
        if aggregate_by_keys.get('c'):
            if 'Count' not in df:
                df['Count'] = 1
            aggregate_by_cols.append('Count')
        if aggregate_by_keys.get('d'):
            if 'Duration' not in df:
                df['Duration'] = (df['Stop Time'] - df['Start Time']).dt.seconds
            aggregate_by_cols.append('Duration')

        grouped = df.groupby(group_by_cols, observed=True)
        counts = (
            grouped
            [aggregate_by_cols]
            .sum()
            .reset_index()
        )
        return counts


class AggregatedMonths(HasRootCLI, MonthsTables):
    DIR = DIR
    CHILD_CLS = AggregatedMonth

    def __init__(
            self,
            group_by_keys: GroupByKeys,
            aggregate_by_keys: AggregateByKeys,
            sort_agg_keys=False,
            **kwargs
    ):
        self.group_by_keys = group_by_keys
        self.aggregate_by_keys = aggregate_by_keys
        self.sort_agg_keys = sort_agg_keys
        super().__init__(**kwargs)

    def month(self, ym: Monthy) -> AggregatedMonth:
        return AggregatedMonth(ym, group_by_keys=self.group_by_keys, aggregate_by_keys=self.aggregate_by_keys)


def cmd(fn):
    @decos([ GroupByKeys.opt(), AggregateByKeys.opt() ])
    @wraps(fn)
    def _fn(*args, group_by, aggregate_by, **kwargs):
        group_by_keys = GroupByKeys.load(group_by)
        aggregate_by_keys = AggregateByKeys.load(aggregate_by)
        fn(*args, group_by_keys=group_by_keys, aggregate_by_keys=aggregate_by_keys, **kwargs)
    return _fn


AggregatedMonths.cli(
    help=f"Aggregate normalized ride entries by various columns, summing ride counts or durations. Writes to <root>/{DIR}/KEYS_YYYYMM.parquet.",
    cmd_decos=[yms_arg, cmd],
)
