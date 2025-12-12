# CTBK DVX Integration Notes

## Overview

This document captures the plan and considerations for integrating DVX (Data Version Control, eXtended) into the ctbk pipeline.

## DVX Format Decisions

### Simplifications from DVC

Consider diverging from DVC format to create a cleaner, minimal DVX spec:

1. **`frozen: true`** - Purpose unclear in our context. Consider removing from DVX specs.

2. **`outs` as array** - DVC supports multiple outputs per .dvc file. DVX philosophy is "one computation → one output". Consider:
   - Making `outs` a single object, not an array
   - Or keeping array for compatibility but only using first element

3. **File extension** - Options:
   - Keep `.dvc` for compatibility with existing tooling
   - Use `.dvx` to clearly distinguish DVX-managed files from legacy DVC files
   - Benefit of `.dvx`: clearly signals "this is DVX format" and avoids confusion with legacy DVC APIs we don't intend to support

### Minimal DVX Spec

Proposed minimal format:
```yaml
# output info
outs:
- md5: <hash>
  size: <bytes>
  path: <relative_path>

# provenance (optional for leaf nodes / imports)
computation:
  cmd: "ctbk norm create 202501"
  deps:
    - path: ../tripdata/202501-citibike-tripdata.zip.dvc
      md5: <hash_from_that_dvc>
```

For imported/external data (leaf nodes), no `computation` block - just `outs`.

---

## CTBK Pipeline Architecture

### Current Pipeline Stages

```
TripdataZips (s3://tripdata, external)
  │
  ├── NYC: YYYYMM-citibike-tripdata.zip
  └── JC:  JC-YYYYMM-citibike-tripdata.csv.zip
  │
  ▼
NormalizedMonths (s3/ctbk/normalized/)
  │
  │  Problem: Upstream zips are sloppy - ride records for month X
  │  may appear in zip file for month Y.
  │
  │  Solution: Explode into parquets namespaced by:
  │    - start_month (when ride started)
  │    - end_month (when ride ended)
  │    - zip_month (which zip file contained it)
  │
  │  Output: normalized/YYYYMM/ directories with files like:
  │    - 202412_202501.parquet (rides starting Dec 2024, ending Jan 2025)
  │    - 202501_202501.parquet (rides fully within Jan 2025)
  │
  ▼
ConsolidatedMonths (s3/ctbk/consolidated/ - may not exist yet?)
  │
  │  Reads from ALL normalized month directories to gather
  │  all rides that belong to a given month (regardless of
  │  which zip they arrived in).
  │
  │  Includes deduplication logic for rides that appear
  │  in multiple zips.
  │
  │  Output: consolidated/YYYYMM.parquet (single file per month)
  │
  ▼
AggregatedMonths (s3/ctbk/aggregated/)
  │
  │  Histograms grouped by various keys:
  │    - y (year), m (month), d (day), h (hour), w (weekday)
  │    - r (region), g (gender), t (user_type), b (bike_type)
  │    - s (start_station), e (end_station)
  │
  │  Output: aggregated/KEYS_YYYYMM.parquet
  │
  ▼
StationMetaHists → StationModes → StationPairJsons
```

### Consolidated Dependency Pattern (IMPORTANT)

The key insight from `consolidated.py`:

```python
pqt_paths = glob(f'{dir}/20*/20*_{ym}.parquet')
```

For consolidated month X (e.g., 202501), it globs for `normalized/*/20*_202501.parquet`:
- `normalized/202412/202412_202501.parquet` - rides starting Dec, ending Jan
- `normalized/202501/202501_202501.parquet` - rides fully in Jan
- `normalized/202501/202412_202501.parquet` - rides starting Dec, ending Jan (from Jan's zip)
- etc.

**This means consolidated/202501 depends on ALL normalized/* directories** because rides
ending in January could have started in any prior month, and could have arrived in any zip.

The file naming: `STARTYM_ENDYM.parquet` inside directory `ZIPYM/`

### Historic Data Side-Loading (v0)

Some historic parquets contain data that the upstream source (s3://tripdata) later removed.

Location: `s3/ctbk/normalized/v0/` contains older versions.

For months in [202001, 202101], consolidated.py:
1. Loads current data: `load_dvc_parquets(ym)`
2. Loads v0 data: `load_dvc_parquets(ym, 'v0')`
3. Merges them, backfilling columns (Gender, Birth Year, Bike ID) from v0 where current is missing
4. Deduplicates by (Start Time, Stop Time)

This preserves historic data that Lyft removed when they took over in Feb 2021.

---

## Implementation Plan

### Phase 1: Task Infrastructure

Add to `ctbk/task.py`:
```python
class Task:
    def deps(self) -> list["Task"]:
        """Return upstream dependencies"""
        return []

    @property
    def cmd(self) -> str:
        """CLI command that produces this artifact"""
        raise NotImplementedError

    def to_artifact(self):
        """Convert to DVX Artifact"""
        from dvx.run import Artifact, Computation
        # ... implementation
```

### Phase 2: Normalized Stage

1. `NormalizedMonth.deps()` → returns TripdataZip dependencies
2. `NormalizedMonth.cmd` → `"ctbk norm create {ym}"`
3. Add `prep` subcommand to generate .dvc files
4. Add `run` subcommand to execute via DVX

### Phase 3: Consolidated Stage

1. `ConsolidatedMonth.deps()` → returns ALL NormalizedMonth objects (not just same month!)
   - This is the key insight: consolidated/202501 depends on normalized/* (all months)
   - Because rides for 202501 could be in any upstream zip
2. Handle deduplication in the computation

### Phase 4: Downstream Stages

Wire up: Aggregated → StationMetaHists → StationModes → StationPairJsons

### Phase 5: Historic Data Handling

Document and encode the v0 historic data merging logic.

---

## CLI Design

```bash
# Generate .dvc specs (prep phase - dynamic → static)
ctbk norm prep 202501-202506

# Execute via DVX (static execution)
ctbk norm run 202501-202506

# Combined (prep + run)
ctbk norm create 202501-202506  # existing behavior, now uses DVX under the hood
```

---

## Open Questions

1. Should we use `.dvx` extension instead of `.dvc`?
2. How to handle the "consolidated depends on ALL normalized" relationship efficiently?
3. Should `prep` walk the full DAG (writing upstream .dvc files too) or just immediate stage?

---

## Files to Audit

- `ctbk/normalized.py` - NormalizedMonth, normalize_df, the explode logic
- `ctbk/consolidated.py` - ConsolidatedMonth, the "read all months" logic, dedup
- `ctbk/has_root_cli.py` - where prep/run commands will be added
- `ctbk/task.py` - base Task class to extend
- `ctbk/zips.py` - TripdataZip for leaf node deps

---

## Verified Directory Structure

```
s3/tripdata/
  202501-citibike-tripdata.zip.dvc      # NYC zip (imported, leaf node)
  JC-202501-citibike-tripdata.csv.zip.dvc  # JC zip (imported, leaf node)

s3/ctbk/normalized/
  202501/                               # directory tracked by 202501.dvc
    202412_202501.parquet               # rides starting Dec, ending Jan
    202501_202501.parquet               # rides fully in Jan
  202501.dvc                            # .dir hash, nfiles=2
  v0/                                   # historic data for backfilling
    202001/
    ...

s3/ctbk/aggregated/
  YYYYMM/                               # per-month directories
```

---

## Next Steps (When Resuming)

1. Start with `ctbk norm prep` for a single month
2. Wire up Task.deps(), Task.cmd, Task.to_artifact()
3. Add prep/run subcommands to HasRootCLI
4. Test: `ctbk norm prep 202501` should generate valid .dvc with computation block
5. Then: `ctbk norm run 202501` should execute via DVX
