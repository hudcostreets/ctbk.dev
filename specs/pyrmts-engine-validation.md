# pyrmts-engine: local link + avail validation build

Written by the pyrmts session (2026-07-18). `python/pyrmts_engine` landed in pyrmts `5409dfc` (spec: pyrmts `specs/pyramid-build-engine.md`, incl. implementation notes). This spec covers (a) working against the local pyrmts clone instead of git pins, and (b) the validation task: rebuild avail with `build_local` and require content equality vs the Lambda fan-out build.

## a) Local pyrmts (the Python `pds l`)

Current pins are PEP 508 git URLs in `dependencies` (`pyrmts @ git+...@9d16761#subdirectory=python/pyrmts`). Recommended restructure — plain names in `dependencies`, sources carry the pin, so local↔pinned is a one-line swap per package:

```toml
[project]
dependencies = [
    ...
    "pyrmts",
    "pyrmts_geo",
    "pyrmts-engine",   # NEW — brings polars + click
    ...
]

[tool.uv.sources]
# Pinned (default):
pyrmts        = { git = "https://github.com/runsascoded/pyrmts.git", rev = "5409dfc", subdirectory = "python/pyrmts" }
pyrmts_geo    = { git = "https://github.com/runsascoded/pyrmts.git", rev = "5409dfc", subdirectory = "python/pyrmts_geo" }
pyrmts-engine = { git = "https://github.com/runsascoded/pyrmts.git", rev = "5409dfc", subdirectory = "python/pyrmts_engine" }

# Local (dev) — swap in per-package as needed:
# pyrmts        = { path = "/Users/ryan/c/pyrmts/python/pyrmts", editable = true }
# pyrmts_geo    = { path = "/Users/ryan/c/pyrmts/python/pyrmts_geo", editable = true }
# pyrmts-engine = { path = "/Users/ryan/c/pyrmts/python/pyrmts_engine", editable = true }
```

Then `uv sync`. Notes:

- **Link all three together** when linking any: `pyrmts-engine`'s own `pyrmts` dep is a workspace source only inside the pyrmts repo; from ctbk, your `[tool.uv.sources]` entry for `pyrmts` is what resolves it. Mixed local-engine + pinned-pyrmts would resolve `pyrmts` at the git rev — usually not what you want mid-development.
- Editable installs mean pyrmts-side edits are live in ctbk's venv without re-sync (only metadata changes — deps, entry points — need `uv sync`).
- Don't commit the local-path variant; commit the rev bump when cutting over (same discipline as `pds l` vs `pds gh`).

## b) Validation build (pyrmts spec §Validation)

Goal: rebuild the avail pyramid with `pyrmts_engine.build_local` on one box and require content equality vs the Lambda fan-out's output (avail-v4 once it's the current build; the same procedure works against v3 while v4 is in flight). Wall/$ comparison is the headline benchmark (target: ~15-45 min, ~$1-3 vs ~3.3 h / ~$26-28).

### 1. Implement a GBFS `Source`

```python
class Source(Protocol):
    def read_window(self, start: datetime, end: datetime) -> pl.DataFrame: ...
```

Returns a **long-form** frame for `[start, end)`: columns `(s2_cell: Utf8, dt: Int64 epoch-ms floored to 1min, metric: Utf8, state: Int32, count: Float64)`. This is the raw-ingest analog of `engine_streaming.py`'s `SourceStream`, but emitting long form directly — adapt `avail_ingester` / the accumulator materializer's parse path: raw minute → per-station states → expand via the chain function (v4: `[L10..T=4 vocab cells, s:<short_name>]`) → long rows. No hist-JSON anywhere — that was the point.

Alternative zero-new-code smoke first: `pyrmts_engine.WideShardSource` over the existing `/1m` smallest-rung shards (it parses their hist-JSON back to long form and skips re-writing that rung). Slower than raw ingest but exercises the whole engine path against real data with ~10 lines of driver.

### 2. Run

```python
from pyrmts_engine import build_local, JsonlShardIndex

result = build_local(
    pyramid,                       # from avail YAML + FsStorage/S3Storage scratch prefix
    (GENESIS, TO),
    source,
    pyramid_name='avail-v4-engine-check',
    shard_index=JsonlShardIndex('tmp/engine-check-manifest.jsonl'),
    window='1d',                   # memory dial; ~1-1.5 GB/window long-form for avail
    sort=['s2_cell', 'dt'],        # avail's cell-first shard layout (writer default is bin-first)
)
```

Write to a scratch prefix (`avail-v4-engine-check/`), NOT the serving prefix. `JsonlShardIndex` keeps registration local; nothing touches D1.

### 3. Compare

For every key in the manifest: fetch both builds' shards, canonicalize (parse rows, hist-JSON → dict, sort by `(s2_cell, dt)`), require exact equality. Notes:

- Hist-JSON **string** bytes may differ even when content matches: the engine emits numerically state-sorted keys; older paths vary. Compare parsed dicts, not strings.
- The engine writes zero-row cover tiles as EMPTY shards (registered); the LE's strict materializer bounces some of these as `no_inputs`-then-EMPTY. Key sets should match; investigate any diff.
- Cross-tier monoid rebin probe (the 1h→6h check) as a second, independent assertion.
- Engine output-key set should equal `list_expected_shards(pyramid, range)` minus the source-provided rung (if using `WideShardSource`) — any mismatch is a bug in one of the two planners, report back to pyrmts.

### 4. Report

Wall, peak RSS, $ (if run on Batch/spot), and any content diffs → back to the pyrmts session (spec `specs/pyramid-build-engine.md` stays open in pyrmts until this passes; findings go in its implementation notes).

## Gotchas / knowns

- `pyrmts-engine` requires Python ≥3.10; brings `polars` (~60 MB wheel) into ctbk's venv.
- `build_local` window must be fixed-width and a multiple of the base bin (`1min`) — `1d` default is the measured-good `task_size`.
- Registration ordering: engine records after each PUT. For the validation run (JSONL manifest) this is moot; for any future real run against D1, use `pyrmts_engine.D1ShardIndex` (env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`) — same row shape as `d1_http.register_shard`.
- The engine's `local` executor is single-process (polars threads + source prefetch). If it disappoints on wall, profile before reaching for block-fanout — the pyrmts spec defers that deliberately.
