# Spec: Integrate Ryan's Plotly.js Fork

## Goal

Use Ryan's `plotly.js` fork (`$c/plotly.js`) instead of upstream
`plotly.js@2.x`, so we can:
1. Debug and fix bar-width rendering artifacts (visible width
   inconsistencies in monthly bars on Home + StationDetail)
2. Take advantage of fork-specific improvements (legend traceorder
   fixes, lite bundle, TS conversions, etc.)

## Status: Blocked (rabbit hole)

Initial attempt via `pds init`: `pds init /Users/ryan/c/plotly.js`
swaps the dep (v3.3.1 from the fork). pds auto-manages
`optimizeDeps.exclude` in `vite.config.ts` (no manual edits needed —
see `$js/pds/src/switch.ts`). Type-check passes. But runtime fails
with two issues:

### Issue 1: `react-plotly.js` default import broken

```
Error: Dynamic require of "plotly.js/dist/plotly" is not supported
```

The fork (v3) restructured to ESM-only (`./lib/index.js` as `main`,
`exports` map covers many entry points but not `dist/plotly`).
react-plotly.js v2.6.0 does `require('plotly.js/dist/plotly')` — fails.

**Fix attempt**: wrap with `react-plotly.js/factory`:
```ts
// www/src/plot.ts
import Plotly from 'plotly.js'
import createPlotlyComponent from 'react-plotly.js/factory'
export default createPlotlyComponent(Plotly as any)
```
Replaces `import Plot from 'react-plotly.js'` across 3 files.

### Issue 2: Node globals (`process`) in fork's deps

After Issue 1 fix:
```
ReferenceError: process is not defined
  at util@0.12.5/util.js → assert@2.1.0 → stream-parser → probe-image-size
```

The fork pulls in CommonJS deps (`util`, `assert`, `probe-image-size`)
that expect `process` global. Vite doesn't polyfill these in the
browser by default.

**Possible fixes** (untried):
- Add `define: { 'process.env': {} }` in vite.config
- Use `vite-plugin-node-polyfills`
- Use the fork's pre-built dist UMD bundle (`dist/plotly.js`) via
  a script tag instead of bundling
- Tree-shake the fork to exclude `probe-image-size` (used for image
  trace? we don't use those)

## What's needed to unblock

- A clean fork-vs-Vite story (likely involving `vite-plugin-node-polyfills`
  or fork-side cleanup of CJS deps)
- Confirm the fork's `dist/plotly.js` UMD bundle works as a pre-built
  asset
- Alternatively: try `pds gh plotly.js` to use the fork's pre-built
  `dist` branch (if it exists). The dist branch typically has a
  pre-built bundle that sidesteps the source-level CJS issues.

## Why pursue

Bar-width artifacts (visible at homepage + station-detail trips chart)
are a known, persistent annoyance. Upstream plotly issues exist but
nothing's landed. The fork would let us fix it at the source — an
investment that pays off across multiple ctbk-style projects.

## Workaround

For now, we use upstream `plotly.js@2.35.3`. Bar-width artifacts
remain. Acceptable for v1 of station detail pages.

## Related

- `specs/multi-scale-ts-library.md` — broader factoring (pltly-uplot,
  shared time-range codec) that might let us eventually move some
  charts off plotly entirely
- The `StationAvailabilityChart` already uses uPlot (no plotly) and
  has none of these issues — see if more charts can move that way
