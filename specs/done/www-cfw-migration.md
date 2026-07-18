# www: GH Pages → Cloudflare Workers Assets

**Status: complete 2026-07-18.** ctbk.dev serves from the `ctbk-dev`
Workers-Assets worker (custom domain attached; verified in-browser:
SPA-fallback 200s, stubs, plots, tiles). See "Implementation notes".

## Context

ctbk.dev is a static Vite SPA deployed to GH Pages via `www.yml`
(push to the `www` branch → build → `JamesIves/github-pages-deploy-action`
→ `ghp` branch). The GHP shape forces several hacks:

- **`404.html` fallback** for SPA deep links: `/s/<slug>` returns HTTP
  404 (some crawlers reject it outright).
- **Per-station HTML stubs** (`gen-station-stubs.js` postbuild, ~2.6k
  files) so station deep links return 200 with per-station og meta.
  (Still needed under any host — crawlers don't run JS — but the 404
  problem itself is GHP-specific.)
- **Non-atomic deploys**: GHP can flip `index.html` and the chunk tree
  out of sync, hence the 5-min chunk-polling smoke step (and the
  `ea82f3c0` clean-exclude incident it guards against).
- **Deploy ergonomics**: deploying means moving the `www` branch
  pointer (`git push h main:www`) — repeatedly forgotten (most
  recently 2026-07-17, when a `push h main` deployed nothing).

The API worker (`ctbk-gbfs-api`), cascade Lambda, and R2 data all live
on Cloudflare already; `CORS_ORIGIN = "*"` so an origin change is free.
An experiment (parked as UCs ~2026-07-13) added `wrangler` +
`@cloudflare/vite-plugin` + a `ctbk-dev` Workers-Assets config.

## Design

### Worker: assets-only, no vite plugin

`www/wrangler.jsonc`: name `ctbk-dev`, `assets.directory = "./dist"`,
`not_found_handling = "single-page-application"`, no `main` (pure
static assets — free tier, unlimited asset requests, atomic
manifest-based deploys).

Drop `@cloudflare/vite-plugin` (revert the `vite.config.ts` edit): its
value is dev-mode worker-runtime emulation and worker-entry builds —
we have no worker code. Plain `vite dev` (port 3456) is byte-identical
UX; `wrangler dev` (port 3457, FE+1 per convention) previews the real
assets router locally when needed.

- `pnpm deploy:cf` = `pnpm build && wrangler deploy` (build runs
  prebuild ymdgtb-index + postbuild stubs, so `dist/` is complete).
- Stubs, `og.jpg`, screenshots all ride along as ordinary assets
  (~2.6k files ≪ the 20k Workers-Assets cap).
- `404.html` copy becomes unnecessary (SPA handling) — removed at
  cutover, not before (GHP still serves until the domain flip).

### Rollout: dual-deploy, then flip

1. **Phase A (this spec's implementation)**: deploy to
   `ctbk-dev.<acct>.workers.dev` from the laptop; verify deep links,
   stubs (curl og meta), chunks, CIC plots against the prod API.
2. **Phase B**: `www.yml` gains a `wrangler deploy` step alongside the
   GHP deploy (dual-deploy; workers.dev tracks every deploy). Uses the
   same `CLOUDFLARE_API_TOKEN` secret as `Deploy GBFS Workers`.
3. **Phase C (explicit, user-approved — DNS is user-visible)**: attach
   the `ctbk.dev` custom domain to the worker (`routes` +
   `custom_domain: true`; replaces the GHP DNS records). Then strip:
   GHP deploy step, `404.html` copy, the chunk-sync smoke loop
   (replace with a one-shot 200 check — deploys are atomic now),
   `fix-mime-type.sh` and other GHP relics. Slack notify stays
   (its "last deployed run" query keys on the deploy step name —
   update it).

### Unchanged

- e2e gate, Docker screenshots + og-mosaic + self-commit loop, Slack
  thread, `www` branch as the deploy trigger (deploy-on-main is a
  possible later ergonomic change, but the screenshots self-commit
  flow is entangled with the `www` branch — out of scope here).
- `gen-station-stubs.js` (crawler og meta still needs real per-station
  HTML), og:image URLs (API worker's `/og/s/<slug>.png`).

## Open questions

1. Stale-tab chunk loads after deploy: GHP 404'd them; Workers-Assets
   SPA fallback serves `index.html` (a JS parse error instead). Both
   are broken tabs needing reload; not a regression. A later
   `_headers`/redirect rule or build-time chunk-retention could
   improve on both.
2. Once on Workers, `/og/*` and `/api/*` could be routed same-origin
   to the API worker (service bindings / route splits) — nice-to-have,
   separate spec.

## Implementation notes (2026-07-18)

- **DNS**: `ctbk.dev` was on Squarespace-managed Google Cloud DNS
  (registrar: Squarespace) — Workers custom domains need the zone on
  CF, so the zone moved: added in the CF dashboard, records pruned to
  5 (apex A→GHP for the transition, `www`+`s3` CloudFront CNAMEs +
  their 2 ACM validation records; dead `data`/`flask`/`test`/`test2`
  and Squarespace's `_domainconnect` dropped; everything DNS-only),
  DNSSEC disabled at Squarespace pre-move, nameservers →
  `arturo`/`vida.ns.cloudflare.com`. Zone active ~15 min later.
- **Custom-domain attach via dashboard, not config.** The CI token is
  Workers/R2/D1-scoped (no zone perms): `wrangler deploy` with a
  `routes[custom_domain]` block 403s on the workers-domains API. The
  domain is attached once in the dashboard (which also required
  deleting the apex A record first — the dash flow doesn't
  auto-replace) and persists as account state; `wrangler.jsonc`
  deliberately declares no routes so deploys never touch zone APIs.
- **Phase C strip**: GHP deploy step, `404.html` copy, and the 5-min
  chunk-poll smoke (→ 3-try one-shot; assets deploys are atomic)
  removed; Slack "last deployed" query matches both old + new deploy
  step names for compare-range continuity. Workflow renamed
  `GitHub Pages` → `Deploy ctbk.dev`.
- **Left for later**: delete the `ghp` branch after a bake week
  (instant-rollback insurance: re-add the apex A `185.199.108.153` +
  GH Pages still has the last build); `WWW_DEPLOY_KEY` checkout stays
  (the screenshot self-commit push uses it until
  `specs/www-screenshots-dvx.md` lands); retiring the `www`/`s3`
  CloudFront distros (CF redirect rule / R2 custom domain) would kill
  the ACM records too.
