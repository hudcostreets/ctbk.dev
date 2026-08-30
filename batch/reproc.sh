#!/usr/bin/env bash
# Reproc driver (specs/batch-reproc.md): run ctbk's data DAG, excluding the
# orphaned `csvs/` stage and any `side_effect: true` stages.
#
# Usage:
#   batch/reproc.sh                  # run all in-scope data targets (incremental)
#   batch/reproc.sh -f               # from-scratch: force re-run derived stages
#   batch/reproc.sh <target.dvc>...  # explicit targets (exclusions still apply)
# Extra args (-j N, --push each, --remote reproc, --dry-run, ...) pass through
# to `dvx run`. The container (batch/entrypoint.sh) runs `--no-commit` and does
# the single end-of-run commit+push; this local driver mirrors that default.
#
# The target list comes from `batch/reproc-targets` (see it for why the set is
# what it is). Both entry points share it so there's one definition of scope.
set -euo pipefail
cd "$(dirname "$0")/.."

mapfile -t in_scope < <(batch/reproc-targets)

is_in_scope() {
    local t="$1"
    for e in "${in_scope[@]}"; do [[ "$t" == "$e" ]] && return 0; done
    return 1
}

targets=()
args=()
for a in "$@"; do
    if [[ "$a" == *.dvc ]]; then targets+=("$a"); else args+=("$a"); fi
done
if [[ ${#targets[@]} -eq 0 ]]; then
    targets=("${in_scope[@]}")
else
    kept=()
    for t in "${targets[@]}"; do
        if is_in_scope "$t"; then kept+=("$t")
        else echo "skipping out-of-scope target: $t" >&2; fi
    done
    targets=("${kept[@]}")
fi

echo "reproc: ${#targets[@]} targets" >&2
exec dvx run --no-commit "${args[@]}" "${targets[@]}"
