# `batch/` — full-DAG reproc on Fargate Spot

The reproducibility audit's execution harness. Design + rationale:
[`../specs/batch-reproc.md`](../specs/batch-reproc.md); the gaps it targets:
[`../specs/pipeline-audit.md`](../specs/pipeline-audit.md) §3–§4.

| File | Role |
|---|---|
| `Dockerfile` | Self-contained reproc image: blobless clone + `uv sync` + dvx overridden to `$DVX_REF` (default `95db406f7`, past the committed pin). |
| `reproc-targets` | Prints the 1,363 in-scope `.dvc` (has `cmd:`, not `side_effect: true`). One definition of scope. |
| `reproc.sh` | Local driver: `dvx run --no-commit <in-scope targets>` (+ passthrough flags). Mirrors the container's default. |
| `entrypoint.sh` | Fargate entrypoint: runs dvx, then **one** atomic commit+push of the regenerated `.dvc`s to `reproc-results/<ts>` (needs `$FARGATE_GITHUB_RW_TOKEN`; read-only without it). |

## Reproc remote (one-time, local — never prod's `.dvc`)

```bash
dvx remote add --local reproc s3://ctbk/.reproc      # throwaway prefix
# creds come from .dvc/config.local (s3) — same as the prod read
```

## Run (Phase 1 — gated: provisions AWS infra + ~$1–2 spend)

In the **pyrmts Batch account** (reuse its VPC/subnets/SG). Pull acct/region/subnet/SG
from the pyrmts Pulumi stack first. Needs a fine-grained GH PAT
(`hudcostreets/ctbk.dev` `contents:write` only) in Secrets Manager for the push-back.

```bash
docker build --platform linux/arm64 -t ctbk-reproc:$(git rev-parse --short HEAD) \
  --build-arg REF=$(git rev-parse HEAD) batch/
dvx batch push  <acct>.dkr.ecr.<region>.amazonaws.com/ctbk-reproc:<rev>
dvx batch bootstrap -i <ecr-image> -a ARM64 \
  -s FARGATE_GITHUB_RW_TOKEN=<secrets-manager-arn> \
  -e AWS_DEFAULT_REGION=<region>            # + S3/reproc creds via secret(s)
dvx batch submit -f -r reproc -p each -w    # flags-only; entrypoint appends targets
# then, back on a box with both remotes:
dvx cache comm remote:s3 remote:reproc --only 'reproc,!s3'
```
