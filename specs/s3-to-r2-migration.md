# Migrate `s3://ctbk` → R2 (cap public-serving egress)

Status: proposed (2026-08-29). Companion to `iac-finish-the-stack.md` (this is the "Axis 1 — where it serves" change; that spec is "Axis 2 — who manages it"). Nothing here is operational until sequencing is approved: no bucket copies, no DVC-remote repoint.

## Why

`s3://ctbk` is **publicly served** — the frontend fetches trip parquet straight from `ctbk.s3.amazonaws.com/.dvc/files/md5/…`. Public S3 has **unbounded egress**: anyone who hammers those URLs drives egress fees ($0.09/GB) with no ceiling. R2 has **$0 egress**. That single asymmetry is the reason to move all public data serving to R2.

Upstream input (`s3://tripdata`, Citi Bike's public bucket) is unaffected — this is only about ctbk's own derived, publicly-served bucket.

## What's in the bucket (measured 2026-08-29)

`aws s3 ls --summarize --recursive s3://ctbk/` → **261.70 GB (243.7 GiB), 21,136 objects**.

| Prefix | GB | Objects | Disposition |
|---|---:|---:|---|
| `.dvc/` | 204.35 | 18,304 | **Served store** — DVC content-addressed cache (remote url `s3://ctbk/.dvc`). Must migrate; repoint DVC remote. |
| `csvs/` | 42.75 | 458 | Legacy root layout — triage (see below). |
| `normalized/` | 12.18 | 158 | Legacy root layout — triage. |
| `aggregated/` | 1.44 | 1,779 | Legacy root layout — triage. |
| `stations/` | 0.86 | 409 | Legacy root layout — triage. |
| `static/`, `screenshots/`, `index.html` | 0.01 | 25 | Tiny; migrate with the rest. |
| `tmp/` | 0.10 | 1 | **Drop** — scratch (a stray `202301.parquet`). |

The served surface the frontend reads is `.dvc/` (content-addressed) — migrated. The root-level plain-key prefixes are **not** dead legacy; freshness + code trace (2026-08-30) reclassifies them:

| Prefix | Newest object | Role |
|---|---|---|
| `normalized/` | **2026-08-14** (`202607`) | **LIVE** — public archive **and an active input to the rides-v5 pyramid engine.** `ctbk gbfs rides-v5-extend <ym>` (gbfs_cli.py:1120) server-side-copies `.dvc/files/md5/…` → `normalized/{ym}.parquet` each month, *because* the engine's rides factory discovers months by **listing** `s3://ctbk/normalized/` (content-addressed blobs aren't listable-by-month). |
| `aggregated/` | 2024-12 (`202411`) | Public archive only — HR mirror retired ~2024-11. |
| `stations/` | 2024-12 (`202411`) | Public archive only. |
| `csvs/` | 2025-02 (`202501`) | **Whole `csv` stage retired ~Feb 2025** (commit `a00af68c`; norm reads `s3://tripdata` zips directly). Both plain-key AND DVX frozen at 202501 — no fresher DVX fallback. Dead regenerable intermediate; the one true deletion candidate. |

See `specs/pipeline-audit.md` for the full git-verified prefix classification, the DVX-DAG provenance gaps, and the reproc-based reproducibility test that gates any deletion.

**Do not delete any of these** (except possibly `csvs/`, and only after the reproc test in `pipeline-audit.md` §4 proves the DAG rebuilds from primary sources) — they've been publicly shared for years (data-science classes, etc.). Breaking the *link* (moving to `data.ctbk.dev`) is acceptable; deleting the data is not.

**`normalized/` is coupled to the rides-v5 pyramid** and is the hard part:
- The `rides-v5-extend` mirror step must copy into **R2** instead of S3 (R2 supports intra-bucket `CopyObject`).
- The engine's rides factory must **list R2** for month-discovery. That factory runs on the avail/rides Lambda side (pyrmts) — so this is a **pyrmts-coordination item**, not a self-contained ctbk change.
- Safe sequencing: **dual-write** the mirror to both S3 and R2 until the engine is confirmed reading R2, then retire the S3 mirror. Never flag-day the pyramid's live input.

The frozen three (`aggregated/`, `stations/`, `csvs/`, ~45 GB) are pure public-archive copies — copy to R2 for preservation, no ongoing writes, no engine coupling.

## Measured: what S3 costs today (Aug 2026 bill)

Cost Explorer `get-cost-and-usage` grouped by `USAGE_TYPE`, service = S3, Aug 1–28:

| Usage type | $/mo | Note |
|---|---:|---|
| `DataTransfer-Out-Bytes` | **11.38** | **public-serving egress — already the biggest S3 line** |
| `TimedStorage-ByteHrs` | 7.50 | 261 GB at rest |
| `Requests-Tier1` / `-Tier2` | 1.99 | GET/PUT |
| **S3 total** | **~21.08** | |

The egress is over half the storage-vs-transfer split and is the *unbounded* half. Cutover impact: **`DataTransfer-Out` → $0** (R2 egress is free), storage 261 GB drops from $7.50 (S3 $0.023/GB) to ~$3.93 (R2 $0.015/GB). **Net ongoing saving ≈ $13/mo**, and the unbounded-hammer tail risk goes away entirely. That's the justification, in the account's own numbers.

## Egress cost (one-time)

S3 Standard, us-east-1, $0.09/GB (first-10TB tier), decimal GB. AWS is **not** in Cloudflare's Bandwidth Alliance, so there's no S3→R2 discount and no routing trick that avoids it (EC2-in-region hop just moves the same internet-egress charge to the EC2 leg). Bounded and one-time regardless:

- Served store only (`.dvc/`): 204.35 GB × $0.09 = **$18.39**
- Whole bucket minus `tmp/`: 261.60 GB × $0.09 = **$23.54**
- GET requests: 21,136 × $0.0004/1k = **$0.008** (negligible)
- R2 ingress: **$0**

Ongoing after cutover: R2 storage ≈ 262 GB × $0.015/GB-mo = **$3.93/mo** (vs S3 Standard $0.023 = $6.02/mo), and egress **$0** — the whole point.

## Why content-addressing makes this clean

The served store is DVC content-addressed (`.dvc/files/md5/xx/rest`): objects are **immutable**, keyed by content hash. Consequences:

- **Copy is a one-time sync with no mutation races** — a hash that exists never changes; new data only ever adds new hashes.
- **"Shift reads" is a hostname swap** — R2 paths are byte-identical to S3 paths, so repointing is `ctbk.s3.amazonaws.com` → the R2 public host, nothing else.
- **Dual-serving is safe** during the overlap — both buckets return identical bytes for a given hash.

## Sequence

Copy → shift writes → shift reads → decomm. Never a flag-day.

### 0. Provision R2 public access
The bucket (`ctbk`) is already imported into Pulumi (`infra/__main__.py`, `protect=True`). Add:
- A **public custom domain** (e.g. `data.ctbk.dev`) bound to the bucket — declared in Pulumi (this is where `iac-finish-the-stack.md` Axis 2 meets Axis 1; the domain is an infra resource).
- Confirm the `.dvc/files/md5/…` path prefix is publicly readable over that domain.

### 1. Bulk copy S3 → R2 — DONE (2026-08-30, `.dvc/` store)
- Ran `rclone copy s3src:ctbk/.dvc/ r2:ctbk/.dvc/` on `e` (S3→`e` same-region free; `e`→R2 the ~$18 egress). 16 vCPU, `--transfers 24`, ~9 min for 204 GB / 18,304 objects.
- Creds: 6h STS session-token (S3 read) + R2 keys, passed over SSH into rclone's process env — never written to `e`'s disk; verified no artifacts, then stopped `e`.
- Parity: `rclone check` → **0 differences, 18,304 matching files**. 602 large multipart objects couldn't MD5-compare (S3 ETag ≠ plain MD5 for multipart) — verified by size + rclone's upload-integrity check. Optional `--download` byte-check on those 602 remains available.
- **Not yet copied:** the ~57 GB legacy root prefixes (`csvs/`, `normalized/`, `aggregated/`, `stations/`) — pending triage decision. `tmp/` intentionally excluded.

### 2. Shift writes (DVC remote → R2)
- `.dvc/config` currently: `['remote "s3"'] url = s3://ctbk/.dvc`.
- R2 speaks the S3 API via an account endpoint; point DVC at it with `endpointurl` + R2 credentials (in `.dvc/config.local`, never committed). New `dvc push` writes land in R2.
- Optionally **dual-push** (keep the `s3` remote + add an `r2` remote, push to both) for one cycle as a belt-and-suspenders before flipping the default.

### 3. Shift reads (repoint the frontend)
Four hardcoded hostnames — swap `ctbk.s3.amazonaws.com` → the R2 public host (paths unchanged):
- `www/src/hooks/useStationTrips.ts:17` — `S3_BASE`
- `www/src/components/StageCard.tsx:15` — `md5ToS3Url`
- `www/public/assets/station-urls.json` — per-month absolute URLs (regenerate)
- `www/src/components/Footer.tsx:21` — the browsable `index.html` link

⚠️ **`index.html` gotcha:** R2 does **not** auto-generate a bucket index. The Footer's `s3.amazonaws.com/ctbk/index.html` listing has no R2 equivalent out of the box — either generate a static `index.html` as part of the pipeline, drop a tiny listing Worker, or retire the "browse the bucket" affordance. Decide before cutover.

### 4. Verify + decommission
- Parity check: every `.dvc` md5 referenced by the site resolves 200 on R2 with matching bytes.
- Watch R2 traffic pick up; confirm S3 public GETs drop to ~0.
- Then decomm `s3://ctbk`: safest is **read-only + lifecycle-expire** (or leave dormant) rather than immediate delete, so a missed reference degrades to a 403, not data loss. Keep `protect=True` semantics in mind — S3 side isn't Pulumi-managed, but don't hard-delete until the site's been green on R2 for a while.

## Open questions

- **R2 credentials in CI** — the pipeline's `dvc push` runs in GHA (`ctbk.dev@github`). Needs an R2 token (scoped write to `ctbk`) as a secret, mirroring how the D1 RO token is handled. `iac-finish-the-stack.md` Axis 2 should own declaring it.
- **Triage of the ~57 GB legacy root prefixes** — grep the site + published links; likely mostly droppable, which would cut the copy to ~$18.
- **Interaction with `r2-layout.md`** — that spec consolidates R2's *derived-GBFS* prefixes; this migration adds the *trips DVC store* to the same bucket. Confirm the `.dvc/` prefix doesn't collide with the GBFS layout cleanup.
