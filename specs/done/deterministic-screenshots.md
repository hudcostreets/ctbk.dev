# Deterministic Screenshots: What Worked, What Didn't

## Goal
Byte-identical screenshots between local macOS (Apple Silicon) and GHA (Ubuntu x64).

## What was necessary

| Fix | Commit(s) | Why |
|-----|-----------|-----|
| **Playwright engine** | `a5728b10` | Prerequisite for Docker approach (official Docker images). Replaces Puppeteer. |
| **Docker-based pipeline** | `ef99d991`, `5144a4a7` | Same OS + fonts + rendering libs everywhere. GHA runs same Docker image as local. |
| **`--platform linux/amd64`** | `a9e581f4` | **The key fix.** Mac emulates x86_64 via Rosetta, GHA runs native x86_64 → identical Skia codepaths → byte-identical pixels. |
| **Cached map tiles** | `a9601030` → `435ae3ad` | External tile fetches are non-deterministic (server-side rendering variations, compression). Caching tiles as static PNGs eliminates this. |
| **Tile load event** | `f7806b8a` | Replaced blind `sleep` with `data-tiles-loaded` attribute. Prevents screenshot before tiles render. |

## What was unnecessary / red herrings

| Item | Commit(s) | Status |
|------|-----------|--------|
| **z=13 tiles** | Added in `a9601030`, removed in `435ae3ad` | Wrong zoom level. Leaflet actually requests z=12. The z=13 tiles were never served. Superseded by z=12 tiles in `435ae3ad`. |
| **Light `alidade_smooth` tiles (z=12)** | Added in `435ae3ad` | **Now dead weight.** All station screenshots switched to dark mode (`alidade_smooth_dark`) in `a165581c`. 24 PNGs, ~572KB — should be deleted. |
| **`--disable-skia-runtime-opts`** | `9e73b652` (scrns bump) | **Possibly redundant** given `--platform linux/amd64`. The flag prevents Skia from using CPU-specific SIMD opts. But since Docker amd64 forces the same architecture everywhere, Skia codepaths are already identical. The flag is baked into the `scrns` package, not this repo, so it's harmless to leave. Not tested without it. |

## Proposed squashed commit structure

Instead of 11 iterative commits:

1. **Squash**: `a5728b10` + `ef99d991` + `5144a4a7` + `9e73b652` + `a9e581f4`
   → "Switch to Playwright Docker screenshots for cross-platform determinism"
   (Playwright engine, Docker image, GHA workflow, `--platform linux/amd64`)

2. **Squash**: `f7806b8a` + `a9601030` + `435ae3ad`
   → "Cache map tiles locally, wait for tile load event"
   (tile load event, z=12 dark tiles only — skip the z=13 mistake)
   **Also remove light `alidade_smooth` tiles here** since they're unused.

3. **Keep**: `a165581c` — "Cache dark map tiles, switch stations screenshot to dark mode"

4. **Keep**: `7a6864c6` — "Regenerate screenshots from `linux/amd64` Docker build"

5. **Keep**: `c1430083` — "Add `og:image` mosaic: dark stations map + 2 chart panels"

→ 5 clean commits instead of 11.

## Architecture summary

```
Local (macOS M-series)              GHA (Ubuntu x64)
         │                                  │
   docker build                       docker build
   --platform linux/amd64             --platform linux/amd64
         │                                  │
   ┌─────┴─────┐                    ┌───────┴───────┐
   │ Playwright │                    │  Playwright   │
   │ Docker img │                    │  Docker img   │
   │  (amd64)   │                    │   (amd64)     │
   │            │                    │               │
   │ Cached     │                    │  Cached       │
   │ tiles from │                    │  tiles from   │
   │ public/    │                    │  public/      │
   └─────┬─────┘                    └───────┬───────┘
         │                                  │
    byte-identical ═══════════════════ byte-identical
```
