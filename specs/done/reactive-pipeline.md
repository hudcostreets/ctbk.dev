# Spec: Reactive Pipeline — Auto-trigger Ingest on New Data

## Status: Done (2026-04-06)

Implemented via `workflow_run` trigger + `ctbk update` command.

### What was built

- **`ctbk update <ym>`**: CLI command replacing `update.sh`, runs full pipeline (norm → cons → smh → agg → sm → spj → www assets). Inherits `git_dvc_cmd` flags for commit/push/dry-run.
- **`ci.yml`**: Thin GHA wrapper that accepts arbitrary `ctbk` args via `workflow_dispatch`, or auto-detects month via `workflow_run` trigger from `tripdata.yml`.
- **End-to-end chain**: `tripdata.yml` (daily poll) → `ci.yml` (process month) → push to `www` branch → `www.yml` (deploy site with screenshots).

### Differences from spec

- Used `workflow_run` trigger instead of `workflow_dispatch` from `tripdata.yml` (simpler, no `actions: write` permission needed).
- Phase 2 (S3 events) skipped as spec recommended — daily polling is fine.
- Phase 3 (www deployment) handled by `git push origin HEAD:www` at end of `ci.yml`.
- `station-harmonize` skipped in CI (`-S` flag) — needs all consolidated parquets (10.5GB).

### Key files

| File | Change |
|------|--------|
| `ctbk/update.py` | New `ctbk update` command |
| `.github/workflows/ci.yml` | Rewritten as thin `ctbk` wrapper |
| `www/scripts/gen-station-urls.js` | Fixed to work from any cwd |
| `ctbk/tables_dir.py` | Fixed `fs.rm(recursive=True)` bug |
