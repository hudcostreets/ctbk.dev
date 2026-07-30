# 2026-07-29: cascade Lambdas — pyarrow 25.0.0 SIMD segfault on Graviton

## Symptom
From ~2026-07-29T23:34Z, `ctbk-avail-cascade` and `ctbk-avail-cascade-v5` (both on image `ctbk-avail-lambda:latest`, digest `b158e470…`, functions last updated 07-28T23:33Z) failed **every** invocation with silent `Runtime.ExitError` (~3.5 s in, ~530 MB of 10 GB used, no exception, no platform detail line). The failure was surgical: any consolidate item that **reads existing tiles** died; hole-only fills (raw-WAL reads + writes), discovery listings, and registration all kept working. The midnight 07-30 cover re-tiling then queued 15 boundary-consolidation shards (`/1m@2d` … `/7d@56d`) that nobody could write; the health snapshot went `allComplete=false, missing=19+` and the soak monitor fired repeatedly (gap-count 15→25).

## Diagnosis trail
- Same items **succeeded locally** (`ctbk gbfs lambda fill -C avail-v5 -L 1 -R` wrote the head item fine) — env-specific, not data.
- Both functions broke in the same wall-clock window despite touching different pyramids — platform-level, not config-specific.
- ECR ruled out: `:latest` digest present + tagged, no lifecycle policy, function `CodeSha256` matches.
- `PYTHONFAULTHANDLER=1` added via function env (no rebuild) → **`Fatal Python error: Segmentation fault`** in `pyarrow/parquet/core.py:1590 in read` (← `read_table` ← `pyrmts_engine/consolidate.py`), with *multiple threads* crashing simultaneously (interleaved dumps) — parallel column-decode kernels.
- The exact image pulled and run locally (Apple Silicon, Docker arm64): reads the same tiles fine. Image has **pyarrow 25.0.0** (Dockerfile installed `pyarrow` unpinned; the 07-28 rebuild picked up the fresh release). Thread addresses in the dump are aarch64; Lambda arm64 = Graviton, which has SIMD capabilities (SVE) Apple Silicon lacks → suspected bad SIMD dispatch path, plausibly exposed by a fleet/placement change ~23:30Z (no deploy happened at onset time).

## Mitigation (live)
`ARROW_USER_SIMD_LEVEL=NONE` set on all three functions (`ctbk-avail-cascade`, `ctbk-avail-cascade-v5`, `ctbk-avail-rebuild`) via env var — first post-change tick immediately merged: `/1m@1h` wrote, `/1m@2d` wrote 11,945,022 rows / 136 MB / 27 s. Queue self-drained via the normal extension-fill loop.

## Durable fix
`gbfs/lambda/Dockerfile`: `pyarrow==22.0.0` pin (validated dev/writer version). Rebuild + redeploy at next image roll; env-var mitigation stays until then (and is harmless after).

## Impact
- No data loss or wrongness: readers fall back to finer rungs when coarse consolidations are missing (2–4× more R2 fetches on affected ranges, ~26 h window).
- Lesson: unpinned deps in prod images turn upstream releases into time bombs that detonate on *rebuild*, and hardware-specific native bugs can detonate later still, on *fleet placement changes* — with no deploy anywhere near the onset time.
