# Spec: Integrate Ryan's Plotly.js Fork (DONE)

## Goal

Use Ryan's `plotly.js` fork instead of upstream `plotly.js@2.x`, so we
can:
1. Debug and fix bar-width rendering artifacts
2. Take advantage of fork-specific improvements (legend traceorder
   fixes, lite bundle, TS conversions, etc.)

## Status: Done

Resolved by:
1. `pds gh plotly.js` → install pre-built `dist` branch
   (v3.3.1-dist.9a3e8f3) instead of source-level fork checkout
2. `pds init $js/pltly` → migrate off `react-plotly.js` to
   [`pltly`](https://github.com/runsascoded/pltly), which calls
   `Plotly.react()` directly
3. `<PlotlyProvider loader={() => import('plotly.js/basic').then(m =>
   m.default ?? m)}>` in `main.tsx` — pltly fans out to all `<Plot>`
   descendants
4. Bumped `@types/plotly.js` to v3 (matches fork + pltly)
5. Removed `react-plotly.js` and `@types/react-plotly.js`

## Key blockers (all resolved)

### Issue 1: `react-plotly.js` does CommonJS `require`

`react-plotly.js@2.6.0` does `require('plotly.js/dist/plotly')` and
`Plotly.purge` (which the fork no longer exposes the same way). Both
broke under v3.

**Fix**: replaced with `pltly`'s `<Plot>` component, which calls
`Plotly.react()` / `Plotly.purge()` directly via a user-supplied
loader.

### Issue 2: `process is not defined` from CJS deps in source-level entry

`import('plotly.js')` resolves to `./lib/index.js` (full source graph),
which pulls in `probe-image-size` → `assert` → `util`, all expecting
the Node `process` global.

**Fix**: import `plotly.js/basic` (a.k.a. `lib/index-basic.js`)
instead. The basic bundle excludes the image trace, sidestepping
probe-image-size entirely. Sufficient for ctbk (only bar/scatter).

### Issue 3: Fork's exports map blocks `dist/*` UMD bundles

The fork's `exports` map has `"./dist/*": "./*"`, which makes
`plotly.js/dist/basic.min.js` resolve to `plotly.js/basic.min.js`
(missing). Pre-built UMD bundles can't be reached through the exports
map.

**Workaround**: use the source-level `plotly.js/basic` entry (Vite
re-bundles it; ESM-friendly because we sidestepped the broken CJS
deps). If we ever want the pre-built UMD for faster cold-start, the
fork's exports map needs `"./dist/*": "./dist/*"`.

## Notes

- pds auto-manages `optimizeDeps.exclude` in `vite.config.ts` — see
  `$js/pds/src/switch.ts`. No manual edit needed.
- `import('plotly.js/basic')` returns a Module Namespace Object with
  `Plotly` as `default`; the `.then(m => m.default ?? m)` unwraps it
  for both module-namespace and direct-export cases.
- `pltly`'s `<Plot>` doesn't accept a `className` prop. Wrap in a
  styling div if a className is needed (e.g. ctbk's `.plot
  { aspect-ratio: 768/450; }` + global `rect` shape-rendering).

## Related

- `specs/multi-scale-ts-library.md` — broader factoring (pltly-uplot,
  shared time-range codec)
- `StationAvailabilityChart` uses uPlot (no plotly) and has none of
  these issues
