#!/usr/bin/env python
from typing import Union

import numpy as np
import pandas as pd
from numpy import nan
from pandas import Series, DataFrame
from utz import cached_property, err, sxs
from utz.ym import Monthy

from ctbk.aggregated import AggregatedMonth, DIR
from ctbk.has_root_cli import HasRootCLI, yms_arg
from ctbk.month_table import MonthTable
from ctbk.stations.meta_hists import StationMetaHist
from ctbk.tasks import MonthsTables


def row_sketch(a):
    restsum = sum(a[1:])
    total = a[0] + restsum
    num = len(a)
    return {
        'mode_count': a[0],
        'second': a[1] if num > 1 else nan,
        'restsum': restsum,
        'total': total,
        'counts': a,
        'first/second': a[0] / a[1] if num > 1 else nan,
        'mode_pct': a[0] / total,
        'num': num,
    }


def get_row_hist(df: DataFrame, groupby: Union[str, list[str]], sum_key: str = 'count') -> DataFrame:
    idx_name = df.index.name
    if not idx_name:
        raise RuntimeError('Index needs a name')
    if isinstance(groupby, str):
        groupby = [groupby]
    df = df[groupby]
    row_groups = df.reset_index().groupby([idx_name] + groupby)
    if sum_key in df:
        row_hist = row_groups[sum_key].sum()
    else:
        row_hist = row_groups.size().rename(sum_key)
    row_hist = row_hist.reset_index()
    return row_hist


def mode_sketch(row_hist: DataFrame, thresh: float = 0.5, sum_key: str = 'count', idx_name: str = 'Station ID') -> DataFrame:
    counts = row_hist.groupby(idx_name)[sum_key].apply(lambda s: list(reversed(sorted(s.values))))
    def annotate(counts: pd.DataFrame) -> pd.DataFrame:
        row_sketches = (
            counts
            .apply(row_sketch)
            .apply(Series)
        )
        below_thresh = row_sketches[row_sketches.mode_pct < thresh]
        if not below_thresh.empty:
            err(f'{len(below_thresh)} index entries with mode_pct < {thresh}:\n{below_thresh}')
        annotated = (
            row_hist
            .sort_values([idx_name, sum_key], ascending=False)
            .drop_duplicates(subset=idx_name)
            .set_index(idx_name)
        )
        return sxs(annotated, row_sketches).drop(columns=[sum_key]).sort_values('mode_pct')

    return counts.apply(annotate)

def transform(df: DataFrame) -> DataFrame:
    df = df.set_index('Station ID')
    station_name_row_hist = get_row_hist(df, groupby='Station Name')
    annotated_station_names = mode_sketch(station_name_row_hist)
    station_ll_row_hist = get_row_hist(df, groupby=[ 'Latitude', 'Longitude' ])
    annotated_stations = mode_sketch(station_ll_row_hist)
    joined = sxs(
        annotated_station_names['Station Name'],
        annotated_stations[[ 'Latitude', 'Longitude', ]],
    ).rename(columns={
        'Station Name': 'name',
        'Latitude': 'lat',
        'Longitude': 'lng',
    })
    return joined


class ModesMonthJson(MonthTable):
    NAMES = [ 'station_modes_json', 'smj', 'modes_month_json', 'mmj', 'station_modes', 'sm', ]
    DIR = DIR

    @property
    def url(self):
        return f'{self.dir}/{self.ym}/stations.json'

    @property
    def cmd(self) -> str:
        return f"ctbk sm create -w0 {self.ym}"

    def dep_artifacts(self):
        # Depends on StationMetaHist(in), StationMetaHist(il), AggregatedMonth(e,c)
        from dvx.run.artifact import Artifact
        smh_in = StationMetaHist(self.ym, 'in')
        smh_il = StationMetaHist(self.ym, 'il')
        agg_ec = AggregatedMonth(self.ym, 'e', 'c')
        # Load each dep's md5 from its committed `.dvc` (like `agg`/`norm`), not a
        # bare `to_artifact()` — the latter leaves md5=None when the output isn't
        # materialized locally, and `get_dep_hashes` then silently drops the dep.
        # These deps are files (no `.dir`), so `from_dvc`'s hash is exact.
        return [
            Artifact.from_dvc(smh_in.url) or smh_in.to_artifact(),
            Artifact.from_dvc(smh_il.url) or smh_il.to_artifact(),
            Artifact.from_dvc(agg_ec.url) or agg_ec.to_artifact(),
        ]

    @staticmethod
    def get_mode_sketch(df):
        n = len(df)
        total = df['count'].sum()
        df['total'] = total
        df['n'] = n
        df['frac'] = df['count'] / total
        df['ratio'] = df['count'] / df['count'].shift(-1)
        return df

    @classmethod
    def compute_mode(cls, df):
        n = len(df)
        if n > 1:
            df = (
                df
                [['name', 'count']]
                .sort_values('count', ascending=False)
            )
            mode_sketch = cls.get_mode_sketch(df)
            err(f'{mode_sketch.head()}')
        return df['name'].iloc[0]

    @staticmethod
    def ll_mean(df):
        return Series({
            'lat': np.average(df.lat, weights=df['count']),
            'lng': np.average(df.lng, weights=df['count']),
        })

    @cached_property
    def idx2id(self):
        stations = self.read().reset_index()
        stations.index.name = 'idx'
        return stations.id

    @cached_property
    def id2idx(self):
        ids = self.idx2id.reset_index()
        id2idx = ids.set_index('id').idx
        return id2idx

    def _df(self) -> DataFrame:
        smh_in = StationMetaHist(self.ym, 'in')
        df_in = smh_in.read().set_index('id')
        name_groups = df_in.groupby('id')
        names = name_groups.apply(self.compute_mode).rename('name')

        smh_il = StationMetaHist(self.ym, 'il')
        df_il = smh_il.read().set_index('id')
        ll_groups = df_il.groupby('id')
        lls = ll_groups.apply(self.ll_mean)
        stations = sxs(names, lls).reset_index()
        stations.index.name = 'idx'

        ec_am = AggregatedMonth(self.ym, 'e', 'c')
        ec_df = ec_am.read()
        ends = (
            ec_df
            .rename(columns={
                'End Station ID': 'id',
                'Count': 'ends',
            })
            .set_index('id')
            .ends
        )
        stations = sxs(names, lls, ends)
        stations['ends'] = stations.ends.fillna(0).astype(int)
        return stations

    def read(self) -> DataFrame:
        with self.fd('r') as f:
            df = pd.read_json(f, orient='index', convert_axes=False)
        df.index.name = 'id'
        return df

    def _write(self, df):
        with self.fd('w') as f:
            df.to_json(f, orient='index')

    @property
    def save_kwargs(self):
        return dict(write_kwargs=self._write)


class ModesMonthJsons(HasRootCLI, MonthsTables):
    DIR = DIR
    CHILD_CLS = ModesMonthJson

    def month(self, ym: Monthy) -> ModesMonthJson:
        return ModesMonthJson(ym)


ModesMonthJsons.cli(
    help=f"Compute canonical station names, lat/lngs from StationMetaHists. Writes to <root>/{DIR}/YYYYMM/stations.json.",
    cmd_decos=[yms_arg],
)
