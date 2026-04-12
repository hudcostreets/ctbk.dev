# 202601 Pipeline Completion Spec

## Context
The 202601 data pipeline has been run successfully (all Python steps). There are remaining tasks to finish and commit.

## Current State

### Completed
All `update.sh 202601` Python steps ran successfully:
- `ctbk norm create 202601` - normalized (1,845,632 rides)
- `ctbk cons create 202601` - consolidated
- `ctbk smh create -gil 202601` / `-gin 202601` - station metadata
- `ctbk agg create -ge -ac 202601` / `-gse -ac 202601` / `-g ymrgtb -acd 202601` - aggregations
- `ctbk sm create 202601` - station modes → `s3/ctbk/aggregated/202601/stations.json`
- `ctbk spj create 202601` - station pair JSONs → `s3/ctbk/aggregated/202601/se_c.json`
- `ctbk ymrgtb-cd -f` - dashboard JSON updated

### Failed
- `node www/scripts/gen-station-urls.js` - missing `yaml` npm package. Need to `cd www && pnpm install` first, then re-run.

### Git Status
Staged:
- `ctbk/tripdata_month.py` (modified) - fix for JC-202601 zip naming (`.zip` not `.csv.zip`)
- `s3/ctbk/aggregated/e_c_202601.parquet.dvc` (new)
- `s3/ctbk/aggregated/se_c_202601.parquet.dvc` (new)
- `s3/ctbk/aggregated/ymrgtb_cd_202601.parquet.dvc` (new)
- `s3/ctbk/normalized/202601.dvc` (new)
- `s3/ctbk/normalized/202601.parquet.dvc` (new)
- `s3/ctbk/stations/meta_hists/il_202601.parquet.dvc` (new)
- `s3/ctbk/stations/meta_hists/in_202601.parquet.dvc` (new)
- `www/public/assets/ymrgtb_cd.json` (modified) - updated dashboard data

Not yet staged (needs `dvx add` or `git add`):
- `s3/ctbk/aggregated/202601/` directory - contains `stations.json` and `se_c.json`, needs DVC tracking

Untracked (ignore):
- `s3/ctbk/normalized/v0/README.md`
- `tmp0lv_oih9.tmp`

## Remaining Tasks

1. **Track the aggregated/202601/ directory**: `dvx add s3/ctbk/aggregated/202601` (or individual files)
2. **Fix gen-station-urls.js**: `cd www && pnpm install && node scripts/gen-station-urls.js`
3. **DVC push**: Push all new data to S3 remote
4. **Git commit**: Commit all `.dvc` files, the `tripdata_month.py` fix, and `ymrgtb_cd.json`
5. **Git push**: Push to remote (the EC2 node may not have SSH keys for GitHub - may need to push from laptop instead)

### Note on tripdata_month.py fix
The JC zip naming is inconsistent (202510=`.zip`, 202511-202512=`.csv.zip`, 202601=`.zip`). The current fix hardcodes exceptions. A more robust approach would be to check what file actually exists, but that's a separate concern.

### Note on git push
EC2 doesn't have GitHub SSH keys. After committing, the changes need to be pulled/pushed from a machine with access. Options:
- Add SSH key on EC2
- Push from laptop after pulling the commit somehow
- Use a personal access token
