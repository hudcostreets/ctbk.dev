# Screenshots + README in the DVX DAG

Status: proposed (2026-09-14).

## Motivation

Screenshots (and the `README` that embeds them) are regenerated today by an
ad-hoc, hand-rolled mechanism rather than by the dependency graph that already
governs the rest of the pipeline:

- A **"data clock"** — `www.yml`'s screenshot-regen gate reads a combined md5 of
  the `s3/ctbk/aggregated/ymrgtbs_cd_*.parquet.dvc` aggregates (recently
  repointed there from `ymdgtb.dvc`; see `push-screenshots.py` `auto_data_md5`
  and the `www.yml` `scrgate` step), compares it to `www_tree`, and to the
  `.deps.json` provenance stored beside the screenshots on S3.
- A **regen-and-record dance** — when either input drifts, GHA rebuilds the
  screenshots in a Docker image, pushes them + a fresh `.deps.json`, and the
  provenance-commit / re-dispatch flow effectively "commits and re-dispatches
  itself."

That md5-clock is a hand-rolled stand-in for what [DVX] gives us for free: a
dependency edge that goes dirty when an input changes and drives a regen. The
screenshots are just an *output* with declared inputs — model them as a DVX
target and the clock, the `.deps.json` sidecar, and the self-dispatch dance all
collapse into `dvx status` + `dvx repro`.

[DVX]: https://github.com/runsascoded/dvx

## Design

Two DVX targets, wired into the existing DAG:

- **`screenshots`** — a DVX target whose deps are `{the web-ui source tree
  (`www/`, minus the screenshots themselves), and (see open questions) the
  rides/data artifacts the homepage chart renders}`. Its output is the
  `public/screenshots/` PNGs, content-addressed into the DVX cache like every
  other artifact.
- **`README`** — a DVX target with dep `{screenshots}`. It embeds each shot by
  its `data.ctbk.dev` DVX-cache URL (content-addressed), so the `README` file
  itself stays text-only and its dependency is just the pointer hash — a shot
  changing flips the `screenshots` `.dvc` md5, which dirties `README`.

`dirty → regen` then falls straight out of the DAG, using the same DVX
invalidation ctbk already invests in for `norm`/`cons`/`agg`/pyramids. No
separate clock, no `.deps.json`.

### The linchpin (and the catch): pixel-idempotency

A DVX target is only well-behaved if regenerating it from unchanged inputs
reproduces the **byte-identical** output — otherwise the `.dvc` md5 flips on
every run and the target is perpetually dirty. For a parquet stage this is
routine; for a **browser screenshot it is genuinely hard**. Cross-machine
byte-identical renders fight font hinting, antialiasing, subpixel rounding, GPU
vs. software rasterization, and headless-Chrome minor versions. Do not
understate this: naive `scrns` output is *not* reproducible across laptops.

It *is* achievable **within a single pinned Docker image**: fixed
`linux/amd64`, a pinned Playwright/Chromium (`Dockerfile.screenshots` already
pins `mcr.microsoft.com/playwright:v1.60.0-noble` — the starting point to
harden), bundled fonts (no host font fallback), GPU disabled / software
rendering forced, and a fixed viewport/DPR. The rule that makes the whole design
work: **that Docker image is THE canonical, sole sanctioned generator** — a
local `docker run` and the CI run produce the same bytes, and nothing regens
screenshots any other way. "Pixel-identical across arbitrary machines" is not a
goal; "pixel-identical out of the canonical image, anywhere it runs" is.

## CI policy: fail-on-stale, not self-commit

CI gates on a clean DVX tree: **`dvx status` must report no stale targets, or CI
fails.** On failure the author regenerates locally via the canonical Docker path
and commits the refreshed `.dvc` pointer(s). CI never commits or re-dispatches
itself.

This kills the self-dispatch dance (which only exists *because* the screenshots
were never modeled as reactive outputs) and generalizes to a repo-wide
invariant: **CI fails if any DVX target is stale** — the same gate that backs the
"CI catches stale pyramids/derived data" goal elsewhere.

**Critical caveat, load-bearing:** fail-on-stale is only viable once regen is
pixel-idempotent. If it isn't, every contributor's rerun produces different
bytes, `dvx status` is always dirty, and CI is permanently red — strictly worse
than the current clock. So the Docker-canonical, byte-reproducible render path
is a hard prerequisite, not a follow-up.

## Sequencing

1. **Pin & prove.** Harden `Dockerfile.screenshots` (fonts, GPU off, fixed
   viewport/DPR, pinned Chromium) and prove pixel-idempotency: repeated runs of
   the canonical image yield byte-identical PNGs, and a CI run matches a local
   `docker run`. Until this holds, do not proceed.
2. **Model the targets.** Add the `screenshots` `.dvc` (deps = web-ui tree
   [+ data]) and the `README` `.dvc` (dep = screenshots); regen via the Docker
   path; push to the DVX cache; embed by cache URL in `README`.
3. **Flip CI.** Replace `www.yml`'s `scrgate` md5-clock + `.deps.json` flow with
   a `dvx status` fail-on-stale gate, and retire `auto_data_md5` /
   `ymrgtb`-aggregate clock in `push-screenshots.py`.

## Open questions / risks

- **Data as a dep?** The homepage rides chart changes as monthly ride data lands,
  so a pure `www/`-tree dep would leave the homepage shot stale on data-only
  months (exactly what the current data-clock exists to catch). Declaring the
  rides/aggregate artifacts as a `screenshots` dep is probably right — but scope
  it to the artifacts that actually move visible pixels, not the whole pipeline.
- **How much monthly data actually moves pixels?** A new month nudges bar heights
  on the all-history chart; quantify whether that reliably changes the PNG bytes
  (it should) so the dep isn't a no-op or, worse, a source of churn on
  imperceptible sub-pixel diffs.
- **Font/Chromium bumps break byte-identity.** Any Playwright image bump is a
  deliberate re-baseline: expect the shots' `.dvc` md5s to change wholesale, and
  land that as its own reviewed commit rather than mixed into content changes.
- **Antialiasing flakiness.** Even in-image, plotly/WebGL layers can introduce
  non-determinism; may need to disable animations, freeze any time-based state,
  and pin DPR. If a residue of nondeterminism survives, a tolerant-compare
  fallback (perceptual-diff threshold) is the escape hatch — but it forfeits the
  clean `dvx status` invariant, so treat it as last resort.
