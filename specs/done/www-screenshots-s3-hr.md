# www screenshots: HR S3 URLs, no git tracking

**Status: implemented 2026-08-15; bootstrap uploaded (15 images + manifest live at `https://ctbk.s3.amazonaws.com/screenshots/`). First input-gated regen on the `www` branch (expected stale: `www_tree` changed) still to be observed.**

## Context

`specs/done/www-screenshots-dvx.md` moved screenshot *bytes* out of git (CA store) but kept `.dvc` pointers + `.deps.json` tracked, purely so `www.yml` could gate regens. Consequence: every regen self-commits "Update screenshot pointers" to `www` **and** `main`, triggering a second, content-identical deploy run (double `:rocket:` Slack pings) and racing concurrent pushes to both branches (3 bounced pushes on 2026-08-14 alone). Per-version tracking of ND renders is also overkill: only the data dep is md5-pinned, so old versions were never reproducible anyway.

## Design

Screenshots live at **human-readable, overwritten-in-place S3 keys** — no git artifacts at all:

```
s3://ctbk/screenshots/<name>.{png,jpg}   # canonical bytes; public HR URL:
                                         #   https://ctbk.s3.amazonaws.com/screenshots/<name>.png
s3://ctbk/screenshots/.deps.json         # provenance + manifest:
                                         #   {ymdgtb_md5, www_tree, images: {name: {md5, size}}}
```

- **`.deps.json` does double duty**: regen gate (same `ymdgtb_md5` data clock + `www_tree` code hash as before) *and* fetch manifest (image names + md5s — no S3 LIST needed, integrity-checked downloads, skip-if-unchanged).
- **`ctbk.dev/screenshots/<name>` unchanged**: `fetch-screenshots.js` (predev/prebuild) now pulls from the S3 manifest instead of resolving `.dvc` pointers; `vite build` copies into `dist/` as before. README + `og:image` URLs untouched.
- **No history**: overwrite in place. The CA store keeps pre-cutover blobs; post-cutover, the current bytes are the only copy (renders are ND and ~monthly; nothing downstream needs old versions).
- **Configurable output** (dev/test): `push-screenshots.py -o <s3://bucket/prefix | local dir>` (default `s3://ctbk/screenshots`); `fetch-screenshots.js` honors `SCREENSHOTS_BASE` (default `https://ctbk.s3.amazonaws.com/screenshots`).

### CI reshape (`www.yml`)

```
1. scrgate: curl S3 .deps.json, compare deps (unchanged logic, no local file)
2. if stale: Docker regen + compose-og (unchanged)
   → push-screenshots.py uploads changed images + fresh .deps.json to S3
     (www branch only; other branches keep the artifact upload instead)
3. build (prebuild fetch = no-op, files already local) → deploy
```

The "Commit screenshot pointers" step **dies** — no self-commit, no second deploy, no bot commits racing `main`/`www`.

### Changes

- `www/scripts/push-screenshots.py`: plain-key uploads (`ContentType` set so HR URLs render in-browser), reads current S3 `.deps.json` for skip-unchanged, writes new one; `-d`/`-t` auto-computed when omitted (local/manual path: `pnpm scrns` → `push-screenshots.py`).
- `www/scripts/fetch-screenshots.js`: manifest-driven fetch + md5 verify (was `.dvc`-driven CA fetch).
- Delete from git: `www/public/screenshots/*.dvc` (17), `.deps.json`. Keep `.gitignore` (`*.png`, `*.jpg`).
- `www/.dockerignore`: regen (`make-dockerignore.py -G`) in same commit.
- Bootstrap: one-time upload of current images + `.deps.json` to `s3://ctbk/screenshots/` **before** merge (the Docker build's `pnpm build` fetches from S3).

### Non-goals

- `plot-fallback.png` (no live consumers) and `og-*.png` (mosaic inputs) migrate as-is; GC separately if desired.
- R2 was considered; S3 wins because the `ctbk` bucket is already the site's public data host and CI/laptop creds exist. Revisit only if S3 egress ever matters.
