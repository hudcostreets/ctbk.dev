from glob import glob
from os.path import join

import pandas as pd
import yaml
from numpy import float64
from pandas import CategoricalDtype, DataFrame, isna
from utz import YM, singleton, err, sxs, solo
from utz.ym import Monthy

from ctbk.has_root_cli import yms_arg, HasRootCLI
from ctbk.month_table import MonthTable
from ctbk.normalized import DIR, OUT_FIELD_ORDER, dedupe_sort, NormalizedMonth, parquet_engine_opt, ParquetEngine
from ctbk.tasks import MonthsTables

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
    df = pd.concat(dfs, ignore_index=True)
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


def get_station_id(df: DataFrame) -> str | None:
    if len(df) == 1:
        return None
    elif len(df) != 2:
        raise ValueError(f"Unexpected IDs dataframe for station name: {df}")
    name = solo(df['name'])
    [id0, id1] = sorted(df['id'].tolist())
    if id0 + "0" != id1:
        err(f"{name}: compatible IDs {id0}, {id1}")
        return None
    return id1


def fix_station_id(df, ds):
    k = 'Start' if 'Start Station ID' in df else 'End'
    name = df[f'{k} Station Name']
    v0 = df[f'{k} Station ID']
    if name in ds:
        v1 = ds[name]
        if v0 + "0" == v1:
            return v1
    return v0


class ConsolidatedMonth(MonthTable):
    DIR = DIR
    NAMES = [ 'consolidated', 'cons', 'con', ]

    def __init__(self, ym: Monthy, /, engine: ParquetEngine = 'auto'):
        self.engine = engine
        super().__init__(ym)

    @property
    def cmd(self) -> str:
        """CLI command that produces this consolidated month."""
        return f"ctbk cons create {self.ym}"

    def dep_artifacts(self):
        """Return dependency artifacts for consolidated month.

        Consolidated parquet for month M includes all rides *ending* in M,
        which can come from any normalized directory (rides from earlier months
        that span into M). Deps are the normalized **directories** that contain
        at least one `*_{M}.parquet` file — identified by scanning each dir's DVC
        `.dir` manifest (not a filesystem glob), so provenance is recordable from
        the tracked `.dvc`s alone, without the normalized data materialized
        locally (the `create` path still globs the actual files).

        Deps are dir-level, not file-level, on purpose: a file *inside* a tracked
        directory has no `.dvc` of its own, so `dvx run`'s ordering resolver
        can't map a file dep back to the `norm` command that produces it (it only
        matches a dep to a producer via an exact `.dvc` or an on-disk path) — a
        file-level dep yields "no ordering edge" and `cons` races ahead of
        `norm`. The dir *does* have a `.dvc` (with the `norm create` cmd), so a
        dir-level dep forms the edge. The cost is coarser invalidation (any
        change within a depended-on dir rebuilds `cons`), which is fine: a source
        month changing is exactly when `cons` should rebuild.

        For 202001-202101: also includes the v0 backfill directories.

        Raises:
            RuntimeError: If any normalized directory's `.dvc`/manifest in
                GENESIS..M is missing (can't guarantee complete deps — upstream
                data can have arbitrary month mappings, so any month could
                contain rides ending in M).
        """
        from pathlib import Path
        from dvx.run.artifact import Artifact
        from dvx.run.dvc_files import read_dvc_file, read_dir_manifest
        from ctbk.util.ym import GENESIS

        ym = self.ym
        base_dir = self.dir  # s3/ctbk/normalized
        suffix = f'_{ym}.parquet'

        def dir_dep(dir_path: str) -> Artifact | None | bool:
            """The dir-level Artifact if this normalized dir has a `*_{ym}`
            file; ``False`` if the dir exists but has no match; ``None`` if the
            dir's `.dvc`/manifest is unavailable."""
            info = read_dvc_file(Path(dir_path))
            if info is None or not info.is_dir or not info.md5:
                return None
            manifest = read_dir_manifest(info.md5)
            if not manifest:
                return None
            if any(relpath.endswith(suffix) for relpath in manifest):
                return Artifact(path=dir_path, md5=info.md5)
            return False

        artifacts: dict[str, Artifact] = {}
        missing = []
        for check_ym in GENESIS.until(ym + 1):
            dep = dir_dep(f'{base_dir}/{check_ym}')
            if dep is None:
                missing.append(str(check_ym))
            elif dep:
                artifacts[dep.path] = dep

        if missing:
            raise RuntimeError(
                f"Cannot prep consolidated {ym}: {len(missing)} normalized directory "
                f"manifests missing. Missing: {', '.join(missing[:5])}"
                f"{'...' if len(missing) > 5 else ''}. Run `ctbk norm create` (and fetch "
                f"the `.dir` manifest blobs) for these months first."
            )

        # For 202001-202101: add v0 backfill directories (best-effort).
        if ym.y >= 2020 and ym <= YM(202101):
            for check_ym in GENESIS.until(ym + 1):
                dep = dir_dep(f'{base_dir}/v0/{check_ym}')
                if dep:
                    artifacts[dep.path] = dep

        # Deterministic order for stable `.dvc` output.
        return [artifacts[p] for p in sorted(artifacts)]

    @property
    def save_kwargs(self):
        return dict(write_kwargs=dict(index=False, engine=self.engine))

    def load_df(self) -> DataFrame:
        norm_dfs = NormalizedMonth(self.ym, engine=self.engine).read()
        dfs = []
        for file, df in norm_dfs.items():
            df = df.assign(file=file)
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
        return pd.concat(dfs)

    def _df(self) -> DataFrame:
        ym = self.ym
        d1 = load_dvc_parquets(ym)
        backfill_cols = DEFAULT_COLS
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
        all_ids = set(d1['Start Station ID']).union(set(d1['End Station ID']))
        bad = [ i for i in all_ids if (i + '0') in all_ids ]
        s_msk = d1['Start Station ID'].isin(bad)
        d1.loc[s_msk, 'Start Station ID'] = d1['Start Station ID'] + '0'
        e_msk = d1['End Station ID'].isin(bad)
        d1.loc[e_msk,   'End Station ID'] = d1[  'End Station ID'] + '0'
        n_s = s_msk.sum()
        n_e = e_msk.sum()
        if n_s or n_e:
            err(f"{ym}: fixed {n_s} Start Station IDs, {n_e} End Station IDs")
        return d1


class ConsolidatedMonths(MonthsTables, HasRootCLI):
    DIR = DIR
    CHILD_CLS = ConsolidatedMonth

    def month(self, ym: Monthy) -> ConsolidatedMonth:
        return ConsolidatedMonth(ym, **self.kwargs)


ConsolidatedMonths.cli(
    help=f"Consolidate normalized parquet files (combine regions for each month, harmonize column names, etc. Populates directory `<root>/{DIR}/YYYYMM/` with files of the form `YYYYMM_YYYYMM.parquet`, for each pair of (start,end) months found in a given month's CSVs.",
    cmd_decos=[yms_arg],
    create_decos=[parquet_engine_opt]
)
