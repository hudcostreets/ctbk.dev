#!/usr/bin/env bash
# Stamped, compare-and-swap worker deploy.
#
# Every deploy annotates the Cloudflare deployment with the git SHA it was
# built from (`--message "sha=<40hex> dirty=<0|1>"`), and refuses to
# overwrite a deployment whose stamp isn't an ancestor of what's being
# deployed. That's the compare half of the swap: without it, any push
# touching `gbfs/<worker>/**` redeploys from git and silently reverts
# whatever was last shipped by hand.
#
# That is not hypothetical — it happened on 2026-08-16: `gbfs/api` had
# ~230 lines of tested-but-uncommitted work running in prod (D1 batch
# chunking, arbitrary `bin=` durations), a `package.json` re-pin push
# tripped the paths filter, and CI shipped git's older source. The
# regression was live for ~7 minutes.
#
# Usage:
#   gbfs/deploy.sh <worker> [-- <extra wrangler args>]
#   gbfs/deploy.sh api
#   gbfs/deploy.sh api --force        # deploy anyway (see below)
#
# Exit codes: 0 deployed, 1 usage/tooling error, 2 CAS check failed.

set -euo pipefail

WORKER="${1:-}"
shift || true
FORCE=0
EXTRA=()
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=1 ;;
        *) EXTRA+=("$arg") ;;
    esac
done

if [ -z "$WORKER" ]; then
    echo "usage: gbfs/deploy.sh <worker> [--force] [-- <wrangler args>]" >&2
    exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR="$REPO_ROOT/gbfs/$WORKER"
[ -d "$DIR" ] || { echo "no such worker dir: $DIR" >&2; exit 1; }

# Paths whose contents end up in this worker's bundle. `gbfs/lib` is
# bundled rather than published, and `gbfs/api` alone imports a config
# asset (`configs/pyramids/station-vocab.json`, `avail_geo.ts:54`) — a
# change to either ships without touching the worker dir. Kept narrow on
# purpose: a broader set means unrelated uncommitted work blocks deploys
# that couldn't possibly include it.
SRC_PATHS=("gbfs/$WORKER" "gbfs/lib")
[ "$WORKER" = api ] && SRC_PATHS+=("configs/pyramids/station-vocab.json")

SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
# `-uno`: untracked files aren't modifications of committed source. The
# repo carries persistent untracked scratch under `gbfs/`, and counting
# it would make every deploy dirty. A brand-new *imported* module is the
# gap this leaves — and that one fails loudly in CI's build instead.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -uno -- "${SRC_PATHS[@]}")" ]; then
    DIRTY=1
else
    DIRTY=0
fi

cd "$DIR"

# ── one D1 database, five pasted ids ─────────────────────────────────
# `database_id` can't reference anything in wrangler.toml, so the id is
# copy-pasted into every worker that binds D1 (`infra/` declares the
# database and exports the id, but nothing consumes that export). The
# failure mode is a re-provision that updates four of the five: workers
# then split across two databases, and the ones left behind read an empty
# or stale D1 rather than failing. Cheap to rule out here, where every
# deploy already passes through.
D1_IDS="$(grep -rhoE '^database_id = "[^"]+"' "$REPO_ROOT"/gbfs/*/wrangler.toml | sort -u)"
if [ "$(printf '%s\n' "$D1_IDS" | grep -c .)" -gt 1 ]; then
    echo >&2
    echo "  ✗ deploy blocked: gbfs/*/wrangler.toml disagree on database_id" >&2
    printf '%s\n' "$D1_IDS" | sed 's/^/      /' >&2
    echo >&2
    echo "  All GBFS workers bind the same D1 database; a split means some" >&2
    echo "  read the wrong one. Reconcile them before deploying." >&2
    exit 1
fi

# ── read prod's stamp ────────────────────────────────────────────────
# `deployments list --json` is chronological; the live one is last.
PROD_MSG="$(npx --no-install wrangler deployments list --json 2>/dev/null \
    | node -e '
        let s = "";
        process.stdin.on("data", d => s += d);
        process.stdin.on("end", () => {
            let ds;
            try { ds = JSON.parse(s) } catch { process.exit(0) }
            if (!Array.isArray(ds) || !ds.length) process.exit(0);
            ds.sort((a, b) => String(a.created_on).localeCompare(String(b.created_on)));
            process.stdout.write(ds[ds.length - 1]?.annotations?.["workers/message"] ?? "");
        });
    ' || true)"

PROD_SHA="$(printf '%s' "$PROD_MSG" | sed -nE 's/.*sha=([0-9a-f]{40}).*/\1/p')"
PROD_DIRTY="$(printf '%s' "$PROD_MSG" | sed -nE 's/.*dirty=([01]).*/\1/p')"

fail() {
    echo >&2
    echo "  ✗ deploy blocked: $1" >&2
    echo >&2
    echo "  prod:     ${PROD_SHA:-<unstamped>}${PROD_DIRTY:+ (dirty=$PROD_DIRTY)}" >&2
    echo "  deploying: $SHA (dirty=$DIRTY)" >&2
    echo >&2
    echo "  $2" >&2
    echo "  Override with --force (or re-run the workflow with force=true)." >&2
    exit 2
}

if [ "$FORCE" = 1 ]; then
    echo "⚠️  --force: skipping the compare-and-swap check"
elif [ -z "$PROD_SHA" ]; then
    # Every deployment predating this script is unstamped; allowing the
    # first one through is what bootstraps the invariant.
    echo "ℹ️  prod deployment carries no stamp — allowing (bootstrap), stamping from here on"
elif [ "$PROD_DIRTY" = 1 ]; then
    fail "prod is running a DIRTY build (deployed from an uncommitted working tree)" \
         "Deploying would silently revert whatever was in that tree. Commit those changes first."
elif [ "$PROD_SHA" = "$SHA" ]; then
    echo "✓ prod already at $SHA — redeploying the same commit"
elif git -C "$REPO_ROOT" cat-file -e "$PROD_SHA^{commit}" 2>/dev/null; then
    if git -C "$REPO_ROOT" merge-base --is-ancestor "$PROD_SHA" "$SHA"; then
        echo "✓ prod at ${PROD_SHA:0:8} is an ancestor of ${SHA:0:8} — fast-forward"
    else
        fail "prod is at a commit NOT contained by what's being deployed" \
             "Prod would lose commits. Merge or rebase so ${PROD_SHA:0:8} is an ancestor of HEAD."
    fi
else
    # Shallow clone, or a commit that never left someone's laptop.
    fail "prod's SHA ${PROD_SHA:0:8} is not in this repo — can't prove a fast-forward" \
         "In CI this usually means checkout needs 'fetch-depth: 0'."
fi

if [ "$DIRTY" = 1 ] && [ "$FORCE" != 1 ]; then
    fail "working tree is dirty under: ${SRC_PATHS[*]}" \
         "Deploying uncommitted code is how prod gets ahead of git in the first place."
fi

echo "→ deploying gbfs/$WORKER @ ${SHA:0:8} (dirty=$DIRTY)"
npx --no-install wrangler deploy --message "sha=$SHA dirty=$DIRTY" "${EXTRA[@]}"
