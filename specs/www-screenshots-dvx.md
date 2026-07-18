# www screenshots: DVX-tracked, input-gated regeneration

## Context

`www.yml` regenerates homepage screenshots (Docker + Playwright,
~5 min) on EVERY deploy, then gates on **output bytes** (`git diff` on
PNGs) to decide whether anything changed. That's backwards for
renders: the map screenshot and og-mosaic are nondeterministic per run
(live station data, Stadia tiles), so they had to be *excluded* from
the gate (they'd retrigger forever), and a real change triggers a
self-commit to `www` + `main` and a full re-run of the workflow (the
first run's build predates the new screenshots). ~2.1 MB of PNGs
re-committed to git history on each regen.

## Design

### Gate on inputs, not outputs

Regenerate exactly when a declared dep changed since the recorded
provenance (DVX workflow-info in each `.dvc`):

- **Data clock**: the monthly dashboard artifact's `.dvc` md5
  (`s3/ctbk/aggregated/ymrgtb_cd.json.dvc`) — ticks exactly when a new
  tripdata month lands. (The homepage plots now render from the
  rides-v3 pyramid, not this JSON, but the JSON's md5 remains a
  faithful monthly clock until Phase E deletes it — then swap to a
  months-manifest dep.)
- **Code**: the `www/` git tree hash — any FE change legitimately
  invalidates renders.

ND outputs stop being a gating problem: if deps are unchanged, we
never render, so there's nothing to byte-compare.

### PNGs in DVX, not git

`www/screenshots/*.png.dvc` pointers in git; bytes in the existing
public CA store (`s3://ctbk/.dvc/files/md5/…`). Retention: the CA
store stays append-only — renders are ND (tiles, live station data,
browser/font versions) and only the data dep is md5-pinned, so
re-deriving at an old SHA is approximate, NOT byte-reproducible; the
stored blob is the only faithful record of what was live. At ~2 MB ×
~monthly ≈ 25 MB/yr this costs nothing, so no GC machinery. No
denormalized *prior-version* copies anywhere else, though — history
lives only in the CA store + git log of the `.dvc`s.

### HR URLs: the deployed site is the alias

The build fetches screenshot bytes by md5 from the public bucket into
`dist/screenshots/<name>.png` (same no-dvc-CLI pattern as
`gen-ymdgtb-index.js` resolving `.dvc` md5s to public URLs). So
`https://ctbk.dev/screenshots/<name>.png` is the stable
human-readable URL, always matching the deployed site — the HR alias
is a *side effect* of deploying, not a DVX output. `README.md`
switches its relative `www/public/screenshots/…` image paths to those
URLs (a README naturally shows the *current* site). `og.jpg` /
`ctbk-og-mosaic.jpg` references likewise.

### CI reshape (single pass, no self-commit loop)

```
1. dep-check: recorded deps vs current (fast, no Docker)
2. if stale: Docker+Playwright regen → dvc push PNGs → commit .dvc
   updates (provenance) — in THIS run, before the build
3. build (prebuild fetches screenshots by md5 into dist/)
4. deploy (CFW / GHP)
```

The re-run dance dies: screenshots exist before the build consumes
them. Most deploys skip step 2 entirely (~5 min + Docker saved).

## Sequencing

After the CFW migration's Phase C strip (`specs/www-cfw-migration.md`)
— both reshape `www.yml`; do the strip first, then this.

## Open questions

1. `scrns` local dev flow (`pnpm scrns`) writes `public/screenshots/`
   — keep as the manual-regen path, with a small script to
   dvc-add + push the results.
2. `www/public/img/stations-by-creation-date.png` (static, hand-made)
   stays in git — only the *generated* screenshots move to DVX.
