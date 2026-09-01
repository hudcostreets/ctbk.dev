# Full-DAG reproc image (specs/batch-reproc.md).
#
# Self-contained: python + uv + a blobless clone of ctbk.dev + `uv sync`.
# Once dvx publishes its `dvx-batch` base image (`~/c/dvx/specs/batch-executor.md`
# §1) this can become `FROM dvx-batch:<rev>` + clone + sync.
#
# The committed `pyproject.toml` now pins dvx at `39062ef09`. We still override
# dvx to `$DVX_REF` AFTER `uv sync` to guarantee the `[s3]` extra (boto3/s3fs)
# is present; the default matches the project pin. `39062ef09` = `f5a483f31`
# (= `95db406f7` + git-critical-section serialization + `write_dvc()`
# preserve-outs) + per-project batch `prefix` + the leaf-dep-hash-rewrite fix
# (record a tracked dep's `.dvc` out-hash, not a worktree re-hash) — the latter
# is load-bearing for THIS reproc: without it a level-parallel `-f` run records
# phantom leaf-dep hashes that the audit diff would mis-read as findings.
#
# The clone (not COPY) keeps the build context tiny and gives dvx the `.git`
# objects for any `git_deps` hashing. `--filter=blob:none` (blobless): full
# history, blobs fetched lazily on demand — cheap.
#
# Build (arm64, for Graviton Fargate):
#   docker build --platform linux/arm64 \
#     -t ctbk-reproc:$(git rev-parse --short HEAD) \
#     --build-arg REF=$(git rev-parse HEAD) batch/
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
ARG DVX_REF=39062ef09
RUN uv pip install --python /app/.venv \
    "dvx[s3] @ git+https://github.com/runsascoded/dvx@${DVX_REF}"

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONFAULTHANDLER=1

# Container-local git identity: dvx's per-stage `.dvc` md5 writes are made in
# the worktree; the end-of-run commit (entrypoint) needs a committer.
RUN git config --global user.name "dvx-batch" && \
    git config --global user.email "dvx-batch@localhost"

# Push-back entrypoint: after the run, commits the regenerated `.dvc`s and
# `git push`es them to a results branch when $FARGATE_GITHUB_RW_TOKEN is set
# (see batch/entrypoint.sh), else runs read-only. It appends the reproc target
# set to a bare `run` (Batch caps containerOverrides at 8192 bytes, and the
# ~1.3k-path list blows past it — so the submit command is flags-only).
# Copied to / (not /app) so the repo clone can't shadow it.
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
