#!/bin/sh
# Fargate entrypoint (specs/batch-reproc.md, specs/batch-pipeline.md): run dvx
# (or a `script` of ctbk commands), then push the changed `.dvc`s / tracked
# outputs back as ONE commit to a results branch.
#
# Modes:
#   <dvx args>             e.g. `run --no-commit --push each --remote r2 -f -v`
#                          (what `dvx batch submit` sends). With no `.dvc` args,
#                          targets are appended in-container: `$REGEN_TARGETS`
#                          (a `batch/regen-targets` spec, e.g. `-m 201306,…`) if
#                          set, else the full `batch/reproc-targets` set.
#   script '<sh>'          run a shell snippet in /app (non-DVX-runnable steps:
#                          `ctbk station-harmonize create -f`, provenance-less
#                          `ctbk agg create …`), then `dvx push` the cache to
#                          `$DVX_PUSH_REMOTE` (default `r2`) and commit.
#
# Why one commit at the end (not `dvx run --commit --push each`): the DAG runs
# level-parallel, so per-stage `git commit`/`git push` race — concurrent pushes
# get "cannot lock ref … is at X but expected Y" and the losing stages' commits
# never escape (crashes' round-1..10 lesson). So dvx runs `--no-commit` (it
# still *writes* the updated `.dvc` md5s into the worktree), and after the run
# we `git add` + commit + push once: no races, one reviewable commit. Diff it
# against the base commit to see every hash change.
#
# Env:
#   FARGATE_GITHUB_RW_TOKEN  (Secrets Manager) fine-grained PAT, `contents:write`
#                            on hudcostreets/ctbk.dev; absent → no push-back.
#   RESULTS_BRANCH           push-back branch (default `$RESULTS_PREFIX/<ts>`,
#                            `RESULTS_PREFIX` default `reproc-results`).
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  (Secrets Manager) → the repo's
#                            `r2` remote (prod DVX cache, content-addressed:
#                            new blobs never clobber old; nothing is live until
#                            the `.dvc` change merges to main) and `reproc`.
#   REPROC_URL / REPROC_ENDPOINT  optional scratch `reproc` remote (audits).
#   REGEN_TARGETS            `batch/regen-targets` args for a partial regen.
#   BASE_REF                 branch whose `s3/` (data pointers) to start from —
#                            chains a job onto an earlier job's results branch.
#   DVX_CACHED               space-separated `dvx run --cached` patterns (pin
#                            upstream outputs a forced partial regen must not
#                            recompute, e.g. `s3/ctbk/normalized/??????`).
set -e
cd /app

# Chain jobs: start from an earlier job's results branch (e.g. harmonize must
# read the `cons` md5s a preceding regen job pushed), not the image's baked
# clone. The code that runs is still the image's; only the tracked data
# pointers (`.dvc`s, git-tracked outputs) move.
if [ -n "${BASE_REF:-}" ]; then
    git fetch -q origin "$BASE_REF"
    git checkout -q FETCH_HEAD -- s3/
    echo "entrypoint: took s3/ from origin/$BASE_REF" >&2
fi

push_back=no
if [ -n "${FARGATE_GITHUB_RW_TOKEN:-}" ]; then
    git remote set-url --push origin \
        "https://x-access-token:${FARGATE_GITHUB_RW_TOKEN}@github.com/hudcostreets/ctbk.dev.git"
    branch="${RESULTS_BRANCH:-${RESULTS_PREFIX:-reproc-results}/$(date -u +%Y%m%d-%H%M%S)}"
    git checkout -B "$branch"
    push_back=yes
    echo "entrypoint: will commit+push results to origin/$branch after the run" >&2
else
    echo "entrypoint: no FARGATE_GITHUB_RW_TOKEN set; no git push-back" >&2
fi

# Remote creds from env (Secrets Manager) into `.dvc/config.local` — never the
# image or committed config. Idempotent.
if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
    dvx remote modify --local r2 access_key_id "$R2_ACCESS_KEY_ID"
    dvx remote modify --local r2 secret_access_key "$R2_SECRET_ACCESS_KEY"
    echo "entrypoint: configured r2 remote creds" >&2
fi
if [ -n "${REPROC_URL:-}" ]; then
    dvx remote add --local -f reproc "$REPROC_URL"
    [ -n "${REPROC_ENDPOINT:-}" ] && dvx remote modify --local reproc endpointurl "$REPROC_ENDPOINT"
    [ -n "${R2_ACCESS_KEY_ID:-}" ] && dvx remote modify --local reproc access_key_id "$R2_ACCESS_KEY_ID"
    [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && dvx remote modify --local reproc secret_access_key "$R2_SECRET_ACCESS_KEY"
    echo "entrypoint: configured reproc remote -> $REPROC_URL" >&2
fi

# Provenance: with the job def on the mutable `:main` tag, log what's baked in.
echo "entrypoint: image code at $(git rev-parse HEAD)" >&2

# `cons` depends on EVERY normalized dir (any source month can hold rides
# ending in M; `consolidated.dep_artifacts`), read from each dir's `.dir`
# manifest in the local cache. Hydrate just the manifests (~40 KB), not the
# data — same as `ci.yml`'s monthly run.
git ls-files 's3/ctbk/normalized/*.dvc' | xargs dvx pull -m
echo "entrypoint: hydrated normalized .dir manifests" >&2

set +e
if [ "${1:-}" = script ]; then
    shift
    echo "entrypoint: script: $*" >&2
    sh -ec "$*"
    rc=$?
    if [ "$rc" -eq 0 ] && [ "${DVX_PUSH_REMOTE:-r2}" != none ]; then
        dvx push -r "${DVX_PUSH_REMOTE:-r2}"
        rc=$?
    fi
else
    # `run` naming no explicit `.dvc`s: append the target set (+ `--cached` pins).
    is_run=no; has_target=no
    for a in "$@"; do
        [ "$a" = run ] && is_run=yes
        case "$a" in *.dvc) has_target=yes;; esac
    done
    if [ "$is_run" = yes ] && [ "$has_target" = no ]; then
        set -f  # `??????`-style patterns are for dvx, not the shell
        for p in ${DVX_CACHED:-}; do
            set -- "$@" --cached "$p"
        done
        set +f
        if [ -n "${REGEN_TARGETS:-}" ]; then
            # shellcheck disable=SC2046,SC2086
            set -- "$@" $(batch/regen-targets $REGEN_TARGETS)
            echo "entrypoint: appended $(batch/regen-targets $REGEN_TARGETS | wc -l | tr -d ' ') regen targets ($REGEN_TARGETS)" >&2
        else
            # shellcheck disable=SC2046
            set -- "$@" $(batch/reproc-targets)
            echo "entrypoint: appended $(batch/reproc-targets | wc -l | tr -d ' ') reproc targets" >&2
        fi
    fi
    dvx "$@"
    rc=$?
fi
set -e

if [ "$push_back" = yes ]; then
    git add -u
    # New `.dvc`s (a first-time month) aren't caught by `-u`.
    git ls-files -o --exclude-standard -- '*.dvc' | while read -r f; do git add -- "$f"; done
    if git diff --cached --quiet; then
        echo "entrypoint: no tracked changes — nothing to push" >&2
    else
        n=$(git diff --cached --name-only | wc -l | tr -d ' ')
        git commit -q -m "batch results: $n file(s) regenerated @ $(date -u +%FT%TZ) (exit $rc)" \
            -m "batch/entrypoint.sh on AWS Batch; one atomic commit to dodge per-stage push races."
        if git push -u origin HEAD 2>&1; then
            echo "entrypoint: pushed $n changed file(s) to origin/$branch" >&2
        else
            echo "entrypoint: FINAL PUSH FAILED" >&2
            [ "$rc" -eq 0 ] && rc=1
        fi
    fi
fi
exit "$rc"
