# ctbk: migrate public data S3 → R2 (HCCS)

Follow the shared **playbook**: `$c/hccs/path/specs/s3-to-r2-hccs-playbook.md`
(reference impl: `path`, commits `4928858` + `adc022f`). This file is ctbk's deltas.

## Deltas

- **Data store:** DVX remote `s3://ctbk/.dvc` → **`r2://ctbk`** (HCCS account).
- **An `r2` remote already exists — but in the wrong account.** `.dvc/config`'s
  `['remote "r2"']` points at `endpointurl = https://0dcad…r2.cloudflarestorage.com`
  (the OA `0dcad` account, for the disk-tree demo). **Repoint it to the HCCS
  endpoint** (`2363…937e.r2.cloudflarestorage.com`) and make it `core.remote`.
  (There's also an `e` = `ssh://e/…` EC2 cache remote — leave as-is.)
- **Domain (easy — no zone move):** `ctbk.dev` is **already a CF zone**
  (arturo/vida.ns.cloudflare.com). Serve blobs from **`data.ctbk.dev`** (or
  `r2.ctbk.dev`) — trivial R2 custom-domain attach, no registrar/NS work.
- **FE data-loading:** uses hyparquet via **`asyncBufferFromStore`** (not
  `asyncBufferFromUrl`) with S3 URLs. Find the store's base-URL constant and
  repoint to `https://data.ctbk.dev`. Check the store impl for a HEAD probe
  (playbook step 6); ctbk's parquets are moderate — if it HEADs, prefer the
  single-GET buffer for small files, `byteLength` for large.
- **CI:** `.github/workflows/www.yml` (+ many pipeline workflows: gbfs, tripdata,
  step…). Swap the S3 creds used by `dvx pull`/`push` to a ctbk-scoped R2 token;
  audit the pipeline workflows for other `s3://ctbk` writers.
- **disk-tree interplay:** ctbk is a demo bucket in `0dcad`. Once the source is on
  HCCS R2, decide with the disk-tree session whether the demo scans HCCS
  (cross-account token) or keeps a `0dcad` copy (see playbook §disk-tree).

## Open decisions

- Blob hostname under `ctbk.dev` (`data.ctbk.dev` proposed).
- Whether to drop the now-redundant `e`/`0dcad` remotes or keep as fallbacks.

## Progress (2026-09-11)

- **HCCS bucket `ctbk` created + public** (r2.dev URL `https://pub-4b6c7e01aa2349b8b8d6ed788df2a9d1.r2.dev`), HudCoStreets account `2363642879f18d37d52dca114059937e`.
- **Data already lived in RAC (`0dcad`) R2, not just S3** — the served `.dvc/` store (18,304 objs / 190 GiB) + all pyramid prefixes, and `data.ctbk.dev` serves from it. So the copy is **R2→R2 (RAC→HCCS), $0 egress** (rclone on `e`), not S3→R2.
- **Non-gbfs live set copied + parity-verified** (RAC→HCCS): `.dvc` (190 GiB/18,304), `avail-v3` (101 GiB/25,451), `rides-v5` (27 GiB/562), `smg-v1` (18 GiB/284) — object counts + byte sizes match exactly. Everything else (avail-v2/v4/v5/v6, `avail-v3-*` variants, rides-v3, empty-v1*, *-repro, .reproc, trips, tripdata, station-luc.json) is dev/superseded — verify-before-retire, not copied.
- **gbfs backfill** running: full `gbfs/` (raw WAL is the *unreplaceable* data — corrected an earlier mischaracterization; derived `gbfs/avail` is regenerable). ~780k objects / 194 GiB.
- **IaC — the second-copy resources were stood up via Pulumi** (the real test of `iac-finish-the-stack.md`): `infra/__main__.py` made multi-account (AWS reproc-Batch extracted to `infra/aws_reproc.py`, gated by `manage_aws` config; account already `CLOUDFLARE_ACCOUNT_ID`/config-driven). New **`hccs` stack** (`manage_aws: false`, `cloudflare_account_id` secret = HCCS) → `pulumi up` created **D1 `ctbk-gbfs` `845e34bb-d138-4076-9955-5909e30d4323`**, **Queue `gbfs-status-events` `c11bd8a940cc4a73b206b55d438e54d5`**, the `gbfs/status`+`gbfs/info`→queue event-notification, and imported the bucket. Provider gotcha: the CF provider reads `CLOUDFLARE_API_TOKEN`; the HCCS token is `CF_PULUMI_HCCS_TOKEN` in `.envrc`, so map it explicitly (`CLOUDFLARE_API_TOKEN=$CF_PULUMI_HCCS_TOKEN`). Backend still committed local-file (solo-local for now; R2-backend + GHA-Pulumi deferred per `iac-finish-the-stack.md` Increment 1 until CI/2nd-dev).

## Progress (2026-09-11, cont. — GBFS fleet stand-up)

- **Workflows frozen (GH API, no code change):** `gh workflow disable` on
  "Process new month" (`7252321`, rides ingestion — a new month must not land
  on RAC mid-migration) + "Deploy GBFS Workers" (`257120682`, no accidental RAC
  redeploy). Re-enable with `gh workflow enable <id>`.
- **Worker tomls ported RAC→HCCS + committed** (`d7e6762f`): 5× `database_id`
  `d5746734…`→`845e34bb…` (loader, cascade ×2, api ×2); 2× `R2_PUBLIC_BASE_URL`
  `pub-4856603e…`→`pub-4b6c7e01…` (api prod + dev). `deploy.sh` blocks a
  `database_id` split, so they move together. RAC deploys frozen → permanent
  single-account move.
- **HCCS D1 `ctbk-gbfs` (845e34bb) stood up:** schema via `wrangler d1 export
  --no-data` from RAC (ground truth — captures `rg_manifest*` DDL, absent from
  the repo) → applied to HCCS; then copied the durable registry/reference
  tables' DATA (`pyramid_shards` 79.9k, `pyramid_watermarks` 154, `stations`
  2.7k). **Skipped** `rg_manifest` (2.49M rows) — it's a *lazy row-group cache*
  (`fetchShardRows` fills it from R2 parquet footers on miss), so HCCS
  self-warms from the copied shards; saved ~$5 + a huge import. `pyrmts-ops d1
  verify` → "schema up to date".
- **Full HCCS fleet deployed** (`gbfs/deploy.sh`, `CF_PULUMI_HCCS_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID_HCCS`, bootstrap-stamp path): `ctbk-gbfs-{loader,
  cascade,compactor}` (prod) + `ctbk-gbfs-api-dev` (`--env dev`, cron off — no
  double Slack, verification endpoint). Prod api on HCCS deferred to cutover.
  Verified: `/api/health`, `/api/stations/slugs`, avail read-path mechanism.

- **⚠️ Data-copy scope was WRONG — corrected here.** The original "live set"
  copied `avail-v3` (pyramid name `avail`, 22.6k shards) and classified
  `avail-v4/v5/v6` as "dev/superseded, not copied." But the `/api/avail-v3`
  endpoint's `DEFAULT_PYRAMID` is **`avail-v6`**, and the FE also queries
  **`avail-v5`** (`www/src/query/stations.ts`). So the live avail data was
  never copied. **The authoritative "what HCCS needs" is the `pyramid_shards`
  registry**, which references 7 prefixes:
  - `avail-v3/` (pyramid `avail`) — copied ✓
  - `smg-v1/`, `rides-v5/` — copied ✓
  - **`avail-v6/` (67.8 GiB / 26.5k) — LIVE default, was missing**
  - **`avail-v5/` (79.8 GiB / 32.8k) — FE-used, was missing**
  - `avail-v4/` (36.9 GiB, registry-only, not FE-referenced) — genuinely stale, skip
  - `station-luc.json` (root, 470 KB) — load-bearing for the bbox→vocab cover
    (`v5BBoxCover`); was mis-classified superseded. **Copied.**
  `avail-v5`+`avail-v6` copy (~148 GiB, R2→R2) ran on `e`
  (`~/rclone-availv56.sh`) — parity confirmed (Δ ≤13 objs = live drift). NB
  `gbfs/avail/` (54 GiB, parity-verified earlier) is a *different, older*
  prefix than the root `avail-v6/` pyramid the api now serves.
- **Two more non-registry assets were also missing (found via endpoint
  smoke-test, both tiny, laptop-copied):** `station-luc.json` (above) and
  **`empty-v1/` + `empty-v1p/`** (933 objs / 19.4 MiB — the `/api/empty`
  station-states Zarr planes + `empty-v1/stations.json` vocab; not in
  `pyramid_shards`, so the registry enumeration alone missed it).
- **Pre-cutover gate GREEN (2026-09-11):** full FE endpoint surface verified on
  `ctbk-gbfs-api-dev` (HCCS) vs `ctbk-gbfs-api` (RAC), byte-identical —
  `health`, `stations/slugs`, `avail-v3` (24=24), `coverage` (4=4), `rides-v5`
  (48=48), `totals`, `empty`. HCCS serves the entire live surface at parity.
  Lesson: compare response *bodies*, not just status — two 400s can hide a gap
  (`empty` RAC-param-error vs HCCS-vocab-missing looked equal by status).

## Done (2026-09-11)

- **GBFS worker fleet on HCCS** ✓ — `ctbk-gbfs-{poller,loader,cascade,compactor}`
  (prod) + `api` (dev). Serves the full FE surface at parity.
- **DVX `r2` remote → HCCS** ✓ (`core.remote=r2`, endpoint `2363…`, creds
  swapped; commit `03ff9456`).
- **FE worker `ctbk-dev` staged on HCCS** ✓ — deployed at
  `ctbk-dev.hccs-ctbk.workers.dev` (Workers-Assets-only; `ctbk.dev` domain is
  dashboard-attached account state, NOT wrangler config, so this deploy touches
  no domain). Built with `VITE_API_BASE`/`VITE_DATA_BASE` → HCCS. Verified:
  rides chart + station flow-lens render from HCCS. Basemap 401s only because
  Stadia auth is **domain-allowlist** (`ctbk.dev` only) — resolves at the real
  domain post-flip; there is no Stadia key/env to migrate.

## Done — the live flag-day flip (2026-09-11) ✓

Cutover **completed 2026-09-11**. `ctbk.dev` now serves entirely from HCCS
(version `51ad27ea`), all requests 200, basemap works, zero RAC deps. The zone
did **not** move via dashboard remove/add; instead the **registrar** (Squarespace,
not CF Registrar) NS delegation flipped arturo/vida → **duke/hadlee** (HCCS's
assigned NS), and the 7 records were recreated on HCCS: apex→Worker `ctbk-dev`,
`dev`→`ctbk-dev-dev`, `data`→R2 `ctbk` (+ CORS policy), `s3`/`www`→CloudFront
CNAMEs (DNS-only), 2× ACM CNAMEs. CI's CF/R2 secrets → HCCS; `CLOUDFLARE_GHA_D1_RO_TOKEN`
→ HCCS D1 RO (2026-09-12). `dev` branch fast-forwarded to `www` so a future dev
push rebuilds `ctbk-dev-dev` on HCCS defaults. RAC CF workers torn down.

**Tail items (not blockers):**
- **AWS Lambda AWS-account move** — the pyramid-tip `ctbk-avail-cascade{,-v5}`
  (EventBridge 5-min ticks) was env-repointed to write HCCS R2 but still *runs*
  in the RAC AWS account. A new HCCS AWS account (`688066488567`) will host it;
  `create_function` is blocked by the fresh-account 3008 MB memory cap (needs
  10240; measured max use 7.9 GB). Concurrency raised to 1000 (wrong lever);
  memory-cap Support case filed 2026-09-12 (case `178917271400430`). Deploy +
  RAC-Lambda teardown once approved.
- **`Process new month` GHA (`7252321`)** still disabled — re-enable for the
  first full HCCS rides pipeline (202608 waiting).
- **RAC R2 data + D1** kept as backup — purge later, then the de-version
  clean-slate pass.

Runbook that was followed (record):

1. **Deploy prod `ctbk-gbfs-api` + `ctbk-dev-dev` to HCCS.** Rebuild + deploy
   `ctbk-dev` with `VITE_API_BASE`=HCCS prod api, `VITE_DATA_BASE`=`data.ctbk.dev`.
2. **Move `ctbk.dev` zone RAC→HCCS** (dashboard, both accounts — RACx removes,
   HCCSx adds). **NS/downtime unknown** until HCCS shows the assigned NS — if
   different from RAC's, registrar NS update + propagation; do at low traffic.
3. **Recreate 7 records on HCCS**: apex `ctbk.dev`→Worker `ctbk-dev`;
   `dev`→`ctbk-dev-dev`; `data`→R2 `ctbk` (attach custom domain to HCCS bucket);
   `s3`/`www`→CloudFront CNAMEs (as-is); 2× ACM CNAMEs (as-is).
4. **Verify live `ctbk.dev` on HCCS** (basemap now works — allowlisted domain).
5. **Retire RAC**: delete RAC gbfs workers + `ctbk-dev`; swap CI creds
   (`CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` → HCCS); repoint the daily
   engine/compaction GHA at HCCS (starts forward `avail-v6` landing + reconcile).
- **rides/`normalized`**: monthly cadence → clean between-months cutover
  (repoint `rides-v5-extend` writer + pyrmts factory reader to HCCS). No
  dual-write.
