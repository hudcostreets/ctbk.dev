# Spec: per-station Open Graph images

Status: **open** (2026-05-02).

## Goal

Each station detail page (`/s/<slug>`) should have a unique, informative
og:image that renders well as a link preview in Slack / Discord / iMessage
/ Twitter, including:

- Station name + short_name + capacity
- A small map snippet centered on the station
- A recent availability sparkline (last 24h or 7d, mean bikes)
- Headline static stats: 12-month trip total, daily-average rides
- An ephemeral-window label noting the data freshness ("through
  2026-05-02 22:34Z")

3,000 stations × one PNG each is fine for static rendering, but stale
data is the failure mode (someone shares a link, the preview shows
last-week's chart). So the system needs a freshness story.

## Design

### Architecture: Worker + Satori

A new Cloudflare Worker (`ctbk-og`, or a new route on `ctbk-gbfs-api`)
generates OG images on demand:

- `GET /og/station/<id>.png` — slug, short_name, or UUID.
- Worker resolves the station (existing `/api/stations/<id>/info`
  helper).
- Fetches the same `/api/totals?kind=availability` and
  `/api/totals?kind=trips` calls the page would.
- Renders a 1200×630 PNG using **Satori** (`@vercel/satori`) +
  **resvg-wasm**: JSX → SVG → PNG, all in the worker.
- Returns the PNG with `Cache-Control: public, max-age=600,
  stale-while-revalidate=3600`. Tuned per station class (popular stations
  → shorter TTL; quiet stations → longer).

Satori in a CFW: works, but has constraints — no full HTML/CSS parser,
font assets must be inlined or fetched once at startup, no canvas
operations beyond the JSX rendering. It's enough for the mosaic layout.

### Layout (1200 × 630)

```
+---------------------------------------------+
|                                             |
|  Hoboken Terminal — Hudson St & Hudson Pl   |
|  #HB101 · 24 docks · since 2021-06-03       |
|                                             |
|  +--------------+   +-------------------+   |
|  |              |   |                   |   |
|  |   MAP        |   |  AVAIL SPARKLINE  |   |
|  |   (radial)   |   |  (last 7d, mean)  |   |
|  |              |   |                   |   |
|  +--------------+   +-------------------+   |
|                                             |
|  ●●● 12,432 trips/year  ·  34 rides/day     |
|  through 2026-05-02 22:34Z                  |
|                                             |
|                            ctbk.dev         |
+---------------------------------------------+
```

- **Map snippet**: a small static map (raster tile or vector) centered on
  station's lat/lng, ~280×280 px. Use Stamen / Stadia tiles (already used
  by the live map) cached at the worker.
- **Sparkline**: SVG path drawn directly in JSX. Last 7d × 1h bins
  (h1 tier — fastest path). No axes; just a stroke + filled area under.
- **Stats**: 12-month trips total + daily-avg from
  `/api/totals?kind=trips&scope=stations&filter.short_name=<...>&from=now-365d&to=now`.
- **Freshness label**: `through <to>Z` from the avail call's last bin.

### Data sourcing

Worker hits the existing `/api/totals` endpoint (or its internal
`executeAvailTotalsQuery` / `executeTotalsQuery` calls if Worker→Worker
fetch is too slow) for:

1. Avail sparkline: `kind=availability&metric=bikes&agg=mean&bin=3600&from=-7d&to=now`.
2. Trip stats: `kind=trips&metric=count&scope=stations&filter.short_name=<name>&from=-365d&to=now`.
3. Station metadata: `/api/stations/<id>/info`.

All three in parallel → < 500ms cold, near-instant warm. Total OG
generation budget: ~1-2s on cold, sub-100ms on warm.

### Caching

Each `/og/station/<id>.png` response: `Cache-Control: public,
max-age=600, stale-while-revalidate=3600`. Combined with crawler
behavior (Twitter, Slack, etc. cache aggressively for hours-to-days),
the per-station regen rate is on the order of once per hour at most,
even for popular stations.

The `/api/totals` calls behind the OG worker share the same edge cache
as the FE — no extra storage.

### Crawler integration

The `/s/<slug>` page's `<head>` needs:

```html
<meta property="og:image" content="https://og.ctbk.dev/og/station/<slug>.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:title" content="<station name> — ctbk.dev" />
<meta property="og:description" content="<station short_name>, <capacity> docks · <12mo trips> rides last year" />
<meta property="twitter:card" content="summary_large_image" />
```

Tricky bit: the SPA renders client-side, so server-rendered `<head>` tags
need to come from somewhere. Options:

1. **CFW HTML rewrite** in front of `ctbk.dev` that injects the
   per-station meta tags based on URL path. Looks up the slug, fetches
   `/api/stations/<id>/info`, rewrites `<head>`. Standard CFW pattern.
2. **Pre-generated per-station HTML** at build time: a `404.html` per
   station prerendered with the right meta tags. 3,000 files; ~1MB total
   gzipped; cheap on GHP. But: stale on info updates.
3. **Static `<meta>` from React Router** + CFW for crawlers only (UA
   sniff). More complex; option 1 is cleaner.

Recommend **option 1**: a small `ctbk-og` worker (or extend the existing
api worker) intercepts Slack/Twitter/etc. crawlers and serves an HTML
shell with the right meta tags + static body for non-JS. Real users
always hit the SPA.

## Fallback: Playwright + GHA cron

If Satori in CFW turns out to be too constrained (e.g. text rendering
quality, layout complexity, font cost), fall back to:

- A GHA workflow runs nightly (`og-images.yml`).
- Spins up Playwright, navigates to a special `/og-preview/<slug>` route
  that renders the OG layout in DOM at 1200×630.
- Captures PNG, uploads to `s3://ctbk/og/<slug>.png`.
- Worker serves from R2 (CDN-cached after first hit).

Trade-offs vs. Satori:

| | Satori (Worker) | Playwright (cron) |
|---|---|---|
| Freshness | Live (~10min cache) | Daily |
| Build complexity | Medium (font setup, layout limitations) | Low (just DOM) |
| Cost | ~$0 (CFW edge) | ~$0 (GHA + R2) |
| Latency to crawler | < 1s | < 100ms (R2 hit) |
| Stats included | Yes (live API) | Yes (snapshot) |

Satori first; Playwright as safety net.

## Acceptance

- `https://og.ctbk.dev/og/station/hoboken-terminal-hudson-st-hudson-pl.png`
  returns a 1200×630 PNG with the layout above.
- Slack / Discord / Twitter previews show the right image when
  `https://ctbk.dev/s/hoboken-terminal-hudson-st-hudson-pl` is shared.
- Cache hit rate > 90% measurable via `cf-usage r2-ops` (or worker
  analytics).
- Generation latency p50 < 1s, p99 < 3s.

## Open questions

- **Map tiles in Satori**: Satori can't fetch external images at render
  time? Need to verify. Workaround: pre-fetch tile + base64-inline as
  background-image, or pre-render the map snippet to a static PNG per
  station nightly (the cron fallback approach for *just* the map).
- **Font licensing**: Inter / Roboto / system fonts — need to bundle a
  woff2 in the worker. Within R2 free tier easily.
- **Per-region OG**: a "Jersey City" or "NYC" overview OG image? Out of
  scope; scoped to per-station for v1.
