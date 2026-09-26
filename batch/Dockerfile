# Trips-DAG Batch image: full reproc audits (specs/batch-reproc.md) and
# partial / full regens that publish to prod's `r2` DVX remote
# (specs/batch-pipeline.md).
#
# Self-contained: python + uv + a blobless clone of ctbk.dev at `$REF` +
# `uv sync`. The clone (not COPY) keeps the build context tiny and gives dvx the
# `.git` objects for any `git_deps` hashing; `--filter=blob:none` keeps full
# history cheap. `batch/regen-targets` / `batch/reproc-targets` run from the
# clone, so they're the versions at `$REF`.
#
# dvx: `uv sync` installs the project pin; `$DVX_REF` (default = the pin,
# `93e790a6c`) is re-installed on top with the `[s3]` extra (boto3/s3fs) the
# container needs for the R2 remote.
#
# Build + push (arm64, Graviton Fargate), HCCS ECR:
#   dvx batch push -c batch -p linux/arm64 \
#     688066488567.dkr.ecr.us-east-1.amazonaws.com/ctbk-reproc:$(git rev-parse --short HEAD)
# (pass `--build-arg REF=$(git rev-parse HEAD)` via a plain `docker build` if
# the commit isn't `main`'s HEAD; the default `REF=main` builds main).
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG REPO=https://github.com/hudcostreets/ctbk.dev
ARG REF=main
RUN git clone --filter=blob:none "$REPO" /app && git -C /app checkout "$REF"
WORKDIR /app

# Flat venv (the multi-version `.venv/<ver>/` layout is a direnv-ism; containers
# want the plain shape). `--no-dev`: reproc needs runtime deps only.
RUN uv sync --frozen --no-dev

# Override dvx past the committed pin (see header). `[s3]` extra is idempotent
# if ctbk's own deps already cover it.
ARG DVX_REF=93e790a6c
RUN uv pip install --python /app/.venv \
    "dvx[s3] @ git+https://github.com/runsascoded/dvx@${DVX_REF}"

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONFAULTHANDLER=1

# Container-local git identity: dvx's per-stage `.dvc` md5 writes are made in
# the worktree; the end-of-run commit (entrypoint) needs a committer.
RUN git config --global user.name "dvx-batch" && \
    git config --global user.email "dvx-batch@localhost"

# Push-back entrypoint (batch/entrypoint.sh): `dvx run` (targets appended
# in-container from `$REGEN_TARGETS` / `batch/reproc-targets` — Batch caps
# containerOverrides at 8192 bytes) or `script '<sh>'`, then ONE commit of the
# changed tracked files to a results branch when $FARGATE_GITHUB_RW_TOKEN is
# set. Copied to / (not /app) so the repo clone can't shadow it.
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
