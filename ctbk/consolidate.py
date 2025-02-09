from glob import glob
from os.path import join

import pandas as pd
import yaml
from click import option
from numpy import float64
from pandas import CategoricalDtype, DataFrame, isna
from utz import YM, singleton, err, sxs

from ctbk.cli.base import ctbk
from ctbk.has_root_cli import dates
from ctbk.normalized import OUT_FIELD_ORDER, dedupe_sort

DEFAULT_COLS = ['Birth Year', 'Gender', 'Bike ID']


def get_dvc_blob_path(dvc_path: str):
    with open(dvc_path, 'r') as f:
        dvc_spec = yaml.safe_load(f)
    out = singleton(dvc_spec['outs'])
    md5 = out['md5']
    blob_path = join('.dvc', 'cache', 'files', 'md5', md5[:2], md5[2:])
    return blob_path


def load_dvc_parquets(ym: YM, subdir: str | None = None):
    dir = 's3/ctbk/normalized'
    if subdir:
        dir += f"/{subdir}"
    pqt_paths = glob(f'{dir}/20*/20*_{ym}.parquet')
    dfs = []
    for pqt_path in pqt_paths:
        file =  '/'.join(pqt_path.rsplit('/', 2)[1:])
        df = pd.read_parquet(pqt_path).assign(file=file)
        if file == '201306/201307_201307.parquet':
            assert len(df) == 1
            # This file contains an almost-dupe of the first row in 201307/201307_201307.parquet:
            #
            #   Start Time           Stop Time Start Station ID Start Station Name Start Station Latitude  Start Station Longitude Start Region End Station ID End Station Name  End Station Latitude  End Station Longitude End Region Rideable Type User Type  Gender Birth Year  Bike ID
            # 0 2013-07-01 2013-07-01 00:10:34              164    E 47 St & 2 Ave              40.753231               -73.970325          NYC            504  1 Ave & E 15 St             40.732219             -73.981656        NYC       unknown  Customer       0       <NA>    16950
            # 0 2013-07-01 2013-07-01 00:10:34              164    E 47 St & 2 Ave              40.753231               -73.970325          NYC            504  1 Ave & E 16 St             40.732219             -73.981656        NYC       unknown  Customer       0       <NA>    16950
            #
            # Note what looks like a typo in "End Station Name", everything else is identical
            err(f"Skipping {file} containing 1 known-dupe row")
        else:
            dfs.append(df)
    df = pd.concat(dfs)
    return df


TIME_COLS = ['Start Time', 'Stop Time']

def merge_dupes(df: DataFrame, cols: tuple[str, ...]) -> DataFrame:
    if len(df) != 2:
        raise ValueError(str(df))
    df = df.sort_values('file')
    r0 = df.iloc[0]
    r1 = df.iloc[1].copy()
    nan0 = all(isna(r0[col]) or col == "Gender" and r0[col] == 0 for col in cols)
    nan1 = all(isna(r1[col]) or col == "Gender" and r1[col] == 0 for col in cols)
    if not nan0 and nan1:
        for col in cols:
            r1[col] = r0[col]
    return r1.to_frame().T.astype(df.dtypes)


@ctbk.command
@option('-c', '--col', 'backfill_cols', multiple=True, help=f'Columns to backfill; default: {DEFAULT_COLS}')
@dates
@option('-n', '--dry-run', is_flag=True, help='Print stats about fields that would be backfilled, but don\'t perform any writes')
def consolidate(
    backfill_cols: tuple[str, ...],
    yms: list[YM],
    dry_run: bool,
):
    """Consolidate `normalized/YM/YM_YM.parquet` files into a single `normalized/YM.parquet`, containing all rides
    ending in the given month.
    """
    backfill_cols = list(backfill_cols) if backfill_cols else DEFAULT_COLS
    for ym in yms:
        d1 = load_dvc_parquets(ym)
        if ym.y >= 2020 and ym <= YM(202101):
            # Earlier versions of Citi Bike data included "Gender", "Birth Year", and "Bike ID" columns for
            # [202001,202101] (ending when Lyft took over in 202102). For those months, we join and backfill those
            # columns.
            t1 = d1[TIME_COLS]
            dup_msk = t1.duplicated(keep=False)
            n_dups = dup_msk.sum()
            if n_dups:
                # 202001 has 136 duplicate rides, also provided in 201912
                dps = d1[dup_msk]
                uqs = d1[~dup_msk]
                grouped = dps.groupby(TIME_COLS)
                dupe_file_groups = grouped.apply(
                    lambda df: ' '.join(
                        f"{file.rsplit('.', 1)[0]}:{num}"
                        for file, num in df.file.value_counts().sort_index().to_dict().items()
                    ),
                    include_groups=False,
                ).value_counts()
                print(f"{ym}: {n_dups} dupes:")
                for files, count in dupe_file_groups.to_dict().items():
                    print(f"\t{files}\t{count}")
                merged_dups = (
                    grouped
                    .apply(merge_dupes, cols=backfill_cols, include_groups=False)
                    .reset_index(level=2, drop=True)
                    .reset_index()
                )
                d1 = pd.concat([ uqs, merged_dups ], ignore_index=True).sort_values(TIME_COLS).reset_index(drop=True)
                t1 = d1[TIME_COLS]
                time_freqs1 = t1.value_counts().value_counts()
                assert time_freqs1.index.tolist() == [1]
            times1 = set(zip(t1['Start Time'], t1['Stop Time']))

            d0 = load_dvc_parquets(ym, 'v0')
            t0 = d0[TIME_COLS]
            time_freqs0 = t0.value_counts().value_counts()
            assert time_freqs0.index.tolist() == [1]
            times0 = set(zip(t0['Start Time'], t0['Stop Time']))

            adds = times1 - times0
            dels = times0 - times1
            both = times0 & times1
            err(f"{ym}: {len(d0)} -> {len(d1)} rides, {len(adds)} adds, {len(dels)} dels, {len(both)} both")

            def na_df(df):
                nas = df.isna()
                nas['Gender'] = (df.Gender == 0) | (df.Gender == 'U')
                nas['Rideable Type'] = df['Rideable Type'] == 'unknown'
                return nas

            nas = sxs(
                na_df(d0).sum(),
                na_df(d1).sum(),
            )
            n0 = len(d0)
            n1 = len(d1)
            nas[0] = nas[0].fillna(n0).astype(int)
            nas[1] = nas[1].fillna(n1).astype(int)
            nas = pd.concat([nas, pd.DataFrame([{0: n0, 1: n1}], index=['Length'])])
            nas = nas[(nas[0] != 0) | (nas[1] != 0)]
            err(f"{ym} NaNs:")
            err(f"{nas}")

            m = d1[TIME_COLS + backfill_cols].merge(d0[TIME_COLS + backfill_cols], on=TIME_COLS, how='left', suffixes=['_1', '_0'])

            def fill_col(k: str):
                nonlocal m, d1
                k1 = f'{k}_1'
                k0 = f'{k}_0'
                c1 = m[k1]
                c0 = m[k0]
                replace = None
                is_nan = lambda s: s.isna()
                if k == 'Gender':
                    replace = 0
                    is_nan = lambda s: s == 0
                    if isinstance(c0.dtype, CategoricalDtype):
                        c0 = c0.map({'U': 0, 'M': 1, 'F': 2}).astype(c1.dtype)
                elif k == 'Bike ID':
                    if c0.dtype == float64():
                        c0 = c0.dropna().astype(str)
                        assert c0.str.endswith('.0').all()
                        c0 = c0.str.replace(r'\.0$', "", regex=True).astype('Int32')
                        c1 = c1.astype('Int32')
                if replace is None:
                    d1[k] = c1.fillna(c0)
                else:
                    d1.loc[(c1 == replace) & (c0 != replace), k] = c0
                nna1 = is_nan(c1).sum()
                nna0 = is_nan(d1[k]).sum()
                filled = nna1 - nna0
                err(f"{k}: filled {filled} of {nna1} NaNs ({filled / nna1 if nna1 else 0:.1%})")
                if replace is not None:
                    d1[k] = d1[k].fillna(replace)

            for col in backfill_cols:
                fill_col(col)

        d1 = dedupe_sort(d1, name=f"{ym}")

        pqt_path = join('s3', 'ctbk', 'normalized', f'{ym}.parquet')
        if not dry_run:
            d1 = d1.drop(columns='file')
            expected_cols = [*OUT_FIELD_ORDER]
            if ym.y < 2020:
                expected_cols.remove('Ride ID')
            elif ym >= YM(202102):
                expected_cols.remove('Bike ID')
                expected_cols.remove('Birth Year')
            cols0 = set(expected_cols)
            cols1 = set(d1.columns)
            extra_cols = cols1 - cols0
            missing_cols = cols0 - cols1
            if extra_cols:
                err(f"{ym}: extra columns: {', '.join(extra_cols)}")
            if missing_cols:
                err(f"{ym}: missing columns: {', '.join(missing_cols)}")

            d1 = d1[[ k for k in OUT_FIELD_ORDER if k in d1 ]]
            d1.to_parquet(pqt_path, index=False)
            err(f"Saved {pqt_path}")
