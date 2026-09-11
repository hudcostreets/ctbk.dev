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

## Remaining

- **GBFS worker fleet → HCCS** (parallel single-writer pollers, per the cutover discussion): deploy `ctbk-gbfs-{poller,loader,compactor,cascade,api}` into the HCCS account wired to the new D1 id `845e34bb…` + queue `c11bd8a9…` + the `ctbk` binding. Per-account wrangler config (`[env.hccs]` or templating) for the D1 `database_id`. Then retire RAC's fleet once verified. No dual-write needed — run both fleets in parallel during overlap.
- **rides/`normalized`**: monthly cadence → clean between-months cutover (repoint the `rides-v5-extend` writer + the pyrmts factory reader to HCCS; don't run the next month until both flipped). No dual-write.
- **App cutover**: DVX `r2` remote endpoint `0dcad`→`2363` + `core.remote`; FE store base-URL → `data.ctbk.dev`; **port `ctbk.dev` zone RAC→HCCS** (R2 custom domains are same-account) + attach `data.ctbk.dev`; swap CI creds.
