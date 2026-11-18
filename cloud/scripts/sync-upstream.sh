#!/bin/sh
# Imports upstream dev into the fork-only cloud/mvp branch, then proves cloud/ still works.
#
#   cloud/scripts/sync-upstream.sh           merge + test, stop before pushing
#   cloud/scripts/sync-upstream.sh --push    also push cloud/mvp to the FORK
#
# Guards: only runs on cloud/mvp with a clean tree; refuses a merge that would change anything
# outside cloud/ relative to upstream dev; aborts the merge if cloud/ tests fail; pushes only to
# the `fork` remote (origin is read-only in this checkout). It never touches the feature branch.
set -eu
cd "$(git rev-parse --show-toplevel)"

[ "$(git rev-parse --abbrev-ref HEAD)" = "cloud/mvp" ] || { echo "run this on cloud/mvp" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }

git fetch origin dev
if git merge-base --is-ancestor origin/dev HEAD; then
  echo "cloud/mvp already contains upstream dev ($(git rev-parse --short origin/dev))."
else
  git merge --no-commit --no-ff origin/dev || { git merge --abort 2>/dev/null || true; echo "merge conflict: aborted, nothing changed" >&2; exit 1; }
  outside=$(git diff --cached --name-only origin/dev | grep -v '^cloud/' || true)
  if [ -n "$outside" ]; then
    git merge --abort
    echo "refused: the merge would change files outside cloud/ relative to upstream dev:" >&2
    echo "$outside" >&2
    exit 1
  fi
  if ! (cd cloud && npm ci --silent && npm test); then
    git merge --abort
    echo "cloud/ tests failed after the merge: aborted, nothing changed" >&2
    exit 1
  fi
  git commit -q -m "Merge upstream dev into cloud/mvp" -m "Nothing outside cloud/ differs from upstream dev."
  echo "merged upstream dev ($(git rev-parse --short origin/dev)) and cloud/ tests pass."
fi

if [ "${1:-}" = "--push" ]; then
  git push fork cloud/mvp
else
  echo "not pushed (pass --push to push cloud/mvp to the fork)."
fi
