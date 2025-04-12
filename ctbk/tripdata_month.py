import calendar
from dataclasses import dataclass
from functools import cached_property
from os.path import basename, join
from typing import IO, Iterator, Literal
from zipfile import ZipFile, BadZipFile

import pandas as pd
from pandas import DataFrame
from utz import YM, err

from ctbk.blob import DvcBlob
from ctbk.import_zips import BKT
from ctbk.paths import S3
from ctbk.util.region import Region


# Prefer type 1, require type 1, prefer type 2, require type 2
NameType = Literal[1, 11, 2, 22]
READ_DTYPES = {
    **{
        c: str
        for c in [
            'start station id', 'end station id',
            'Start Station ID', 'End Station ID',
            'start_station_id', 'end_station_id',
        ]
    },
    'birth year': 'Int16',
    'Birth Year': 'Int16',
    'gender': 'Int8',
    'Gender': 'Int8',
}
READ_KWARGS = dict(
    dtype=READ_DTYPES,
    na_values=r'\N',
    float_precision='round_trip',
)


@dataclass
class TripdataMonth(DvcBlob):
    ym: YM
    region: Region
    name_type: NameType = 1

    DIR = join(S3, BKT)

    @property
    def yym(self) -> str:
        ym = self.ym
        return str(ym.y if self.region == 'NYC' and ym.y < 2024 else int(ym))

    @property
    def region_str(self) -> str:
        return 'JC-' if self.region == 'JC' else ''

    @property
    def name(self):
        return f'{self.region_str}{self.ym}'

    @property
    def zip_basename(self) -> str:
        if self.name == 'JC-202207':
            return f'{self.name}-citbike-tripdata.csv.zip'  # Typo: "citbike"
        elif self.name == 'JC-201708':
            return f'{self.name} citibike-tripdata.csv.zip'  # Typo: " citibike" (space)
        elif self.region == 'JC' or (self.region == 'NYC' and (202401 <= int(self.ym) <= 202404 or int(self.ym) == 202503)):
            return f'{self.name}-citibike-tripdata.csv.zip'  # Extra ".csv" segment
        elif self.region == 'NYC' and self.ym.y <= 2023:
            return f'{self.ym.y}-citibike-tripdata.zip'  # Full-year zips
        else:
            return f'{self.name}-citibike-tripdata.zip'

    @cached_property
    def zip_path(self) -> str:
        return join(self.DIR, self.zip_basename)

    @property
    def path(self) -> str:
        return self.zip_path

    def zip_csv_fds(self) -> Iterator[IO]:
        """Return a read fd for the single CSV in the source .zip."""
        # src = self.src
        ym = self.ym
        zip_yym = int(self.yym)
        zip_path = self.zip_path
        with open(zip_path, 'rb') as z_in:
            z = ZipFile(z_in)
            names = z.namelist()
            err(f'{zip_path}: zip names: {names}')
            if zip_yym < 2024:
                dir0 = f'{zip_yym}-citibike-tripdata'
                if zip_yym >= 2020:
                    # 2020-2023 have per-month Zips nested inside the year Zip
                    inner_zip_name = f'{dir0}/{ym}-citibike-tripdata.zip'
                    with z.open(inner_zip_name, 'r') as inner_zip_fd:
                        inner_zip = ZipFile(inner_zip_fd)
                        csvs = list(sorted([ f for f in inner_zip.namelist() if f.endswith('.csv') and not f.startswith('_') ]))
                        err(f"{ym}: loaded CSVs from annual inner zip: {csvs}")
                        for csv in csvs:
                            yield inner_zip.open(csv, 'r')
                        return
                else:
                    month = ym.m
                    month_name = calendar.month_name[month]
                    dir1 = f'{month}_{month_name}'
                    # "Type 1" name patterns:
                    # ```
                    # $ uzl $z18 | ew csv | rv MACOS | snk2 -t_ | snk3 -st_ | snk2 -st/ | last
                    # …
                    # 2018-citibike-tripdata/3_March/201803-citibike-tripdata_1.csv
                    # 2018-citibike-tripdata/4_April/201804-citibike-tripdata_1.csv
                    # 2018-citibike-tripdata/4_April/201804-citibike-tripdata_2.csv
                    # …
                    # ```
                    # In 2017, there's an extra ".csv" before the "_<N>" suffix:
                    # ```
                    # $ uzl $z17 | ew csv | rv MACOS | snk3 -st_ | snk2 -st/ | last
                    # …
                    # 2017-citibike-tripdata/3_March/201703-citibike-tripdata.csv_1.csv
                    # 2017-citibike-tripdata/4_April/201704-citibike-tripdata.csv_1.csv
                    # 2017-citibike-tripdata/4_April/201704-citibike-tripdata.csv_2.csv
                    # …
                    # ```
                    prefix1 = f'{dir0}/{dir1}/{ym}-citibike-tripdata{".csv" if ym.y == 2017 else ""}_'
                    csvs1 = list(sorted([ f for f in names if f.startswith(prefix1) and f.endswith('.csv') ]))

                    # "Type 2" name patterns:
                    # ```
                    # 2013-citibike-tripdata/201306-citibike-tripdata.csv
                    # 2018-citibike-tripdata/201801-citibike-tripdata.csv
                    # ```
                    name2 = f'{dir0}/{ym}-citibike-tripdata.csv'
                    csvs2 = list(sorted([ f for f in names if f == name2 ]))

                    if not csvs1 and not csvs2:
                        raise RuntimeError(f"Failed to find CSVs in {zip_path} with name patterns: {prefix1}*.csv, {name2}")
                    name_type = self.name_type
                    if name_type == 1:
                        csvs = csvs1 if csvs1 else csvs2
                    elif name_type == 2:
                        csvs = csvs2 if csvs2 else csvs1
                    elif name_type == 11:
                        if csvs2 and not csvs1:
                            raise RuntimeError(f'Expected "type 1" CSV name patterns ({prefix1}*.csv), but only found {csvs2}')
                        csvs = csvs1
                    elif name_type == 22:
                        if csvs1 and not csvs2:
                            raise RuntimeError(f'Expected "type 2" CSV name pattern ({name2}), but only found {csvs1}')
                        csvs = csvs2
                    err(f"{ym}: loaded CSVs from annual zip: {csvs}")
            else:
                csvs = list(sorted([ f for f in names if f.endswith('.csv') and not f.startswith('_') ]))
            if len(csvs) > 1:
                err(f"Found {len(csvs)} CSVs in {zip_path}: {csvs}")

            if not csvs:
                # 202409-citibike-tripdata.zip contains 5 `.csv.zip`s
                csv_zip_names = [
                    f
                    for f in names
                    if f.endswith('.csv.zip')
                       and not f.startswith('_')
                       and not basename(f).startswith('_')
                ]
                for csv_zip_name in csv_zip_names:
                    with z.open(csv_zip_name, 'r') as csv_zip_fd:
                        try:
                            csv_zip = ZipFile(csv_zip_fd)
                        except BadZipFile:
                            raise ValueError(f"Failed to open nested zip file {csv_zip_name} inside {zip_path}")
                        csv_zip_names = csv_zip.namelist()
                        csvs = list(sorted([ f for f in csv_zip_names if f.endswith('.csv') and not f.startswith('_') ]))
                        for csv in csvs:
                            yield csv_zip.open(csv, 'r')
            else:
                for name in csvs:
                    yield z.open(name, 'r')

    def df(self) -> DataFrame:
        dfs = [
            pd.read_csv(csv_fd, **READ_KWARGS)
            for csv_fd in self.zip_csv_fds()
        ]
        (_, df0), *rest = list(enumerate(dfs))
        cols0 = df0.columns.tolist()
        for idx, df in rest:
            cols = df.columns.tolist()
            if cols0 != cols:
                raise ValueError(f"DF 0 columns don't match DF {idx}: {cols0} != {cols}")
        return pd.concat(dfs)
