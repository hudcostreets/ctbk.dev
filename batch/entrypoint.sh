#!/bin/sh
# Fargate entrypoint: run dvx, then push the regenerated `.dvc`s back as ONE
# commit to a results branch.
#
# Why one commit at the end (not `dvx run --commit --push each`): the reproc
# runs the DAG with level-parallelism, so per-stage `git commit`/`git push`
# race — concurrent pushes get "cannot lock ref … is at X but expected Y" and
# the losing stages' commits never escape (crashes' round-1..10 lesson). So we
# run dvx `--no-commit` (it still *writes* the updated `.dvc` md5s into the
# worktree — just doesn't commit), and after the parallel run finishes we
# `git add -u && commit && push` once: no races, one reviewable commit that IS
# the reconciled result (diff it against the base commit to see every hash
# change = a finding).
#
# Token arrives as $FARGATE_GITHUB_RW_TOKEN (Batch injects it from Secrets
# Manager — fine-grained, `hudcostreets/ctbk.dev` `contents:write` only);
# absent it, we run read-only. Targets: Batch caps containerOverrides at 8192
# bytes and the ~1.3k-path list blows past it, so the submit command is
# flags-only and we append `batch/reproc-targets` here.
set -e
push_back=no
if [ -n "${FARGATE_GITHUB_RW_TOKEN:-}" ]; then
    git -C /app remote set-url --push origin \
        "https://x-access-token:${FARGATE_GITHUB_RW_TOKEN}@github.com/hudcostreets/ctbk.dev.git"
    branch="${RESULTS_BRANCH:-reproc-results/$(date -u +%Y%m%d-%H%M%S)}"
    git -C /app checkout -B "$branch"
    push_back=yes
    echo "entrypoint: will commit+push regenerated .dvc to origin/$branch after the run" >&2
else
    echo "entrypoint: no FARGATE_GITHUB_RW_TOKEN set; no git push-back" >&2
fi

# Configure the scratch `reproc` DVC remote from env — kept OUT of committed
# config and the image; url/endpoint arrive as job-def env, creds via Secrets
# Manager (R2_*). Idempotent (`-f`). The container talks only to this remote
# (`dvx run --remote reproc`), so R2 keys suffice — no AWS/S3 creds needed.
if [ -n "${REPROC_URL:-}" ]; then
    ( cd /app
      dvx remote add --local -f reproc "$REPROC_URL"
      [ -n "${REPROC_ENDPOINT:-}" ] && dvx remote modify --local reproc endpointurl "$REPROC_ENDPOINT"
      [ -n "${R2_ACCESS_KEY_ID:-}" ] && dvx remote modify --local reproc access_key_id "$R2_ACCESS_KEY_ID"
      [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && dvx remote modify --local reproc secret_access_key "$R2_SECRET_ACCESS_KEY" )
    echo "entrypoint: configured reproc remote -> $REPROC_URL" >&2
fi

# Append the reproc target set to a `run` that names no explicit .dvc targets.
is_run=no; has_target=no
for a in "$@"; do
    [ "$a" = run ] && is_run=yes
    case "$a" in *.dvc) has_target=yes;; esac
done
if [ "$is_run" = yes ] && [ "$has_target" = no ]; then
    # shellcheck disable=SC2046
    set -- "$@" $(cd /app && batch/reproc-targets)
    echo "entrypoint: appended $(cd /app && batch/reproc-targets | wc -l | tr -d ' ') reproc targets" >&2
fi

# Run dvx WITHOUT exec so we can commit+push after it returns.
set +e
dvx "$@"
rc=$?
set -e

if [ "$push_back" = yes ]; then
    cd /app
    git add -u
    if git diff --cached --quiet; then
        echo "entrypoint: no .dvc changes — nothing to push (fully reproducible)" >&2
    else
        n=$(git diff --cached --name-only | wc -l | tr -d ' ')
        git commit -q -m "reproc results: $n .dvc regenerated @ $(date -u +%FT%TZ)" \
            -m "From-scratch \`dvx run --no-commit -f\` in batch/entrypoint.sh; one atomic commit to dodge per-stage push races."
        if git push -u origin HEAD 2>&1; then
            echo "entrypoint: pushed $n regenerated .dvc to origin/$branch" >&2
        else
            echo "entrypoint: FINAL PUSH FAILED" >&2
            [ "$rc" -eq 0 ] && rc=1
        fi
    fi
fi
exit "$rc"
