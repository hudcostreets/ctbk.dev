import json

import pandas as pd
from utz.ym import Monthy

from ctbk.aggregated import AggregatedMonth, DIR
from ctbk.has_root_cli import HasRootCLI, yms_arg
from ctbk.month_table import MonthTable
from ctbk.stations.modes import ModesMonthJson
from ctbk.tasks import MonthsTables
from ctbk.util.df import DataFrame


class StationPairsJson(MonthTable):
    DIR = DIR
    NAMES = ['station_pairs_json', 'spj']

    @property
    def url(self):
        return f'{self.dir}/{self.ym}/se_c.json'

    @property
    def cmd(self) -> str:
        return f"ctbk spj create -w0 {self.ym}"

    def dep_artifacts(self):
        # Depends on ModesMonthJson (for id2idx) and AggregatedMonth(se,c)
        mmj = ModesMonthJson(self.ym)
        agg_sec = AggregatedMonth(self.ym, 'se', 'c')
        return [
            mmj.to_artifact(),
            agg_sec.to_artifact(),
        ]

    def _df(self) -> DataFrame:
        mmj = ModesMonthJson(self.ym)
        id2idx = mmj.id2idx

        se_am = AggregatedMonth(self.ym, 'se', 'c')
        se = se_am.read()

        se_ids = (
            se
            .rename(columns={
                'Start Station ID': 'sid',
                'End Station ID': 'eid',
                'Count': 'count',
            })
            .merge(id2idx.rename('sidx').to_frame(), left_on='sid', right_index=True, how='left')
            .merge(id2idx.rename('eidx').to_frame(), left_on='eid', right_index=True, how='left')
            [['sidx', 'eidx', 'count']]
        )
        return se_ids

    @property
    def save_kwargs(self):
        return dict(
            fmt='json',
            write_kwargs=self._write,
        )

    def _write(self, df):
        se_ids_obj = self.df_to_json(df)
        with self.fd('w') as f:
            json.dump(se_ids_obj, f, separators=(',', ':'))

    def read(self) -> DataFrame:
        with self.fd('r') as f:
            se_ids_obj = json.load(f)
        return self.json_to_df(se_ids_obj)

    @staticmethod
    def df_to_json(se_ids):
        return (
            se_ids
            .groupby('sidx')
            .apply(lambda df: df.set_index('eidx')['count'].to_dict())
            .to_dict()
        )

    @staticmethod
    def json_to_df(se_ids_obj):
        return pd.DataFrame([
            dict(sidx=sidx, eidx=eidx, count=count)
            for sidx, eidxs in se_ids_obj.items()
            for eidx, count in eidxs.items()
        ])


class StationPairsJsons(HasRootCLI, MonthsTables):
    DIR = DIR
    CHILD_CLS = StationPairsJson

    def month(self, ym: Monthy) -> StationPairsJson:
        return StationPairsJson(ym)


StationPairsJsons.cli(
    help=f"Write station-pair ride_counts keyed by StationModes' JSON indices. Writes to <root>/{DIR}/YYYYMM/se_c.json.",
    cmd_decos=[yms_arg],
)
