# avail.yaml as source of truth (P9)

> **Superseded** (spec triage, 2026-11-19): v5/v6 are driven by `configs/pyramids/*.yaml`; leftover avail-v3 `LADDERS` code removal tracked in `gc-legacy-pyramids.md`.

ctbk currently has the avail-v3 tier ladders **hardcoded in three
places** that all have to agree:

1. `gbfs/cascade/src/avail3/cascade.ts` `LADDERS` (writer)
2. `gbfs/api/src/avail_geo.ts` `TIERS` (reader)
3. `configs/pyramids/avail.yaml` (Python `pyramid-cascade` materializer)

The cascade tests assert (1) ↔ (2) consistency. Nothing asserts (3) ↔
(1,2). YAML drift goes silently undetected until somebody runs Python
pyramid-cascade and gets a different shape than the live system.

This spec makes the YAML the **single source of truth**, with the JS
constants either generated from it or runtime-asserted against it.

## Sequencing

**Hard dependency on `~/c/pyrmts/specs/python-unified-ladder.md`**:
the current `avail.yaml` is in the old `shard: 1d` singular form, and
the Python parser only accepts that. The YAML can't be rewritten to
`shards: [5min..1d]` until Python pyrmts accepts the new shape.

So this phase comes **after** P2 (ctbk JS pin bump + YAML rewrite to
the new format). P2 puts YAML into the new shape; this phase wires JS
to consume it.

## Why JS-hardcoded was a temporary shortcut, not the steady state

At P2 time, the easy thing to do is leave `LADDERS` / `TIERS`
hardcoded in JS and just rewrite the YAML to match. That's the
current trajectory in the umbrella's P2 section. It works because:

- The CFW bundle doesn't ship the YAML (it's a build artifact, not a
  runtime asset).
- The cascade↔api consistency test catches JS-internal drift.

But the YAML still describes the production layout — Python tooling
(`pyramid-status.py`, `ctbk/pyramid_cascade/`, future GHA backfills)
reads it. If the YAML and JS diverge — e.g. someone adds a `30min`
rung to JS for /15m but forgets the YAML — Python tools will work off
a stale model and emit shards at unexpected paths or miss rungs
entirely.

Two failure modes:
1. **Silent skew**: Python writes to paths the api worker doesn't
   read; api falls through to larger shards, slowness goes
   undetected.
2. **Loud break**: Python writes at correct paths but with wrong
   shard durations (because YAML says different rungs), and queries
   see double-counted or missing rows.

(2) bit us before in the canonical/partial era; we don't want to
re-create that risk.

## Approach: codegen at build time

Two viable options:

**(a) Build-time codegen** (recommended): a Node script reads
`configs/pyramids/avail.yaml`, parses it via the pyrmts JS YAML
parser, and writes a `ladders.generated.ts` file checked into git.
Both `gbfs/cascade/src/avail3/cascade.ts` and
`gbfs/api/src/avail_geo.ts` import from that file. Pre-build hook
regenerates; CI runs the regen and fails if the working tree diff is
non-empty (drift caught in PR).

**(b) Runtime YAML bundle**: ship the YAML in the CFW bundle (esbuild
or wrangler YAML loader) and parse it on first worker init. The
parsed value memoized for the worker's lifetime.

Trade-offs:
- (a) keeps bundle small, makes drift visible in PR diffs, but adds
  a build step + a "generated file" people might be tempted to
  hand-edit.
- (b) is one fewer build step + always-fresh, but bloats the bundle
  by a few KB and parses on every worker cold-start (cheap, but
  non-zero).

Recommend (a). Bundle size matters at the CFW edge, and a generated
file with a `// AUTO-GENERATED FROM configs/pyramids/avail.yaml — DO
NOT EDIT` banner is hard to misuse. The generator can also lint —
asserting the YAML is divisibility-chained per tier, that all
referenced cadence labels are valid pyrmts `Duration`s, etc.

## Implementation

### Generator: `scripts/gen-ladders.ts`

```ts
import { readFileSync, writeFileSync } from 'fs'
import { parsePyramidYaml } from 'pyrmts'

const yamlText = readFileSync('configs/pyramids/avail.yaml', 'utf8')
const cfg = parsePyramidYaml(yamlText)

const banner = `// AUTO-GENERATED from configs/pyramids/avail.yaml.
// Run \`pnpm gen:ladders\` (or \`pnpm build\`) to regenerate.
// Edits to this file will be overwritten.`

const tiersSrc = cfg.tiers
  .map((t) => `  { name: ${q(t.name)}, bin: ${q(t.bin)}, shards: [${t.shards.map(q).join(', ')}] }`)
  .join(',\n')

const out = `${banner}
import type { Duration } from 'pyrmts'

export interface LadderTier {
  name: string
  bin: Duration
  shards: Duration[]
}

export const LADDER_TIERS: LadderTier[] = [
${tiersSrc},
]

export const LADDERS: Record<string, Duration[]> =
  Object.fromEntries(LADDER_TIERS.map((t) => [t.name, t.shards]))
`

writeFileSync('gbfs/lib/src/ladders.generated.ts', out)
console.log(`wrote gbfs/lib/src/ladders.generated.ts — ${cfg.tiers.length} tiers`)

function q(s: string) { return JSON.stringify(s) }
```

Lives in `gbfs/lib/src/ladders.generated.ts`, exported from
`gbfs/lib`'s package entry. Both `gbfs/cascade` and `gbfs/api` already
depend on `gbfs/lib`, so this is a one-import wire-up.

### Wiring

```ts
// gbfs/cascade/src/avail3/cascade.ts
import { LADDERS } from '@ctbk/gbfs-lib/ladders.generated'
// (delete the local LADDERS const)

// gbfs/api/src/avail_geo.ts
import { LADDER_TIERS } from '@ctbk/gbfs-lib/ladders.generated'
function makeBaseProps(bucket: R2Bucket): Omit<GeoPyramid, 'dims'> {
  return {
    storage: parquetBackend(r2Storage(bucket)),
    keyTemplate: 'avail-v3/{tier}/{shard}/{period}.parquet',
    tiers: LADDER_TIERS.map((t) => ({ name: t.name, bin: t.bin, shards: t.shards })),
    // ...
  }
}
```

### CI drift check

```yaml
# .github/workflows/ci.yml (or a separate job)
- name: Regenerate ladders.generated.ts
  run: pnpm gen:ladders
- name: Assert no diff
  run: git diff --exit-code gbfs/lib/src/ladders.generated.ts
```

Fails the build if the generated file is stale relative to YAML.

### Python-side parity test

Cheap belt-and-suspenders: a Python test that loads the same YAML
and asserts the parsed `Pyramid.tiers` matches an embedded golden:

```python
# ctbk/pyramid_cascade/tests/test_yaml_parity.py
from pyrmts import parse_pyramid_yaml

def test_avail_yaml_ladder_shape():
    with open('configs/pyramids/avail.yaml') as f:
        cfg = parse_pyramid_yaml(f.read())
    tiers = [(t.name, t.bin, tuple(t.shards)) for t in cfg.tiers]
    assert tiers == [
        ('1m',  '1min',  ('5min', '10min', '30min', '1h', '3h', '12h', '1d')),
        ('2m',  '2min',  ('10min', '30min', '1h', '3h', '12h', '1d', '2d')),
        # ... full list
    ]
```

Both this Python test and the JS codegen reading the same YAML
guarantees agreement. If someone edits YAML without regenerating
JS, CI catches it (drift check). If they edit YAML and JS but skip
the Python test, the Python test catches it.

## Acceptance

- `pnpm gen:ladders` produces `gbfs/lib/src/ladders.generated.ts`
  matching `configs/pyramids/avail.yaml`.
- `gbfs/cascade` + `gbfs/api` import from the generated file; no
  local `LADDERS` / `TIERS` constants.
- CI fails on any YAML→generated drift.
- Python test asserts the YAML shape (catches YAML-side regressions).
- `cascade.test.ts` consistency test (LADDERS ↔ api TIERS) still
  passes, now sourced from generated → generated (always trivially
  equal, but defensive).

## Risk + rollback

Generated files in source control are mildly contentious. If the
codegen approach proves annoying, fallback is the runtime-YAML
approach (b) — but the generated file makes drift visible in diffs,
which I think is worth the friction.

Rollback: delete `ladders.generated.ts`, re-inline the constants in
the two .ts files. No data-shape change; no production impact.

## Cross-reference

- `~/c/pyrmts/specs/python-unified-ladder.md` — Python catch-up (HARD
  dependency)
- `specs/avail-v3-ladder-migration.md` — umbrella; this is P9
- `configs/pyramids/avail.yaml` — the YAML being made authoritative
