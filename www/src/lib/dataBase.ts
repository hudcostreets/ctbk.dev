// Public host for content-addressed DVX blobs (per-station trips JSONs,
// pipeline-stage parquet, station/pairs JSONs). Migrated S3→R2 on 2026-08-30
// (specs/s3-to-r2-migration.md): served from the `ctbk` R2 bucket via the
// data.ctbk.dev custom domain — zero egress vs the old public S3 bucket.
// Override with VITE_DATA_BASE (mirrors the VITE_API_BASE pattern).
export const DATA_BASE = import.meta.env.VITE_DATA_BASE ?? 'https://data.ctbk.dev/.dvc/files/md5'

export const dvcUrl = (md5: string): string => `${DATA_BASE}/${md5.slice(0, 2)}/${md5.slice(2)}`
