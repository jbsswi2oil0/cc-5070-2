#!/usr/bin/env bash
# Run the shared-framing release in a *clean directory*.
#
# The clean tree is materialised from a committed revision (`git archive HEAD`)
# into a fresh temp dir, dependencies are installed there, and the release
# runner executes against that copy. Running from a clean checkout proves the
# artifact is reproducible from checked-in sources alone and does not depend on
# local build residue, node_modules, or a pre-rendered frame.
#
# Env:
#   RELEASE_REV   git revision to test (default: HEAD)
#   RELEASE_OUT   where evidence is written (default: <clean-dir>/evidence)
#   KEEP_CLEAN    if set, leave the clean dir in place for inspection
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REV="${RELEASE_REV:-HEAD}"

# The raw record must point at a real revision, so refuse to release a tree
# whose HEAD does not match what is on disk (uncommitted edits would make the
# evidence unattributable).
if [ "${RELEASE_REV:-}" = "" ] && [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] && [ -z "${ALLOW_DIRTY:-}" ]; then
  echo "error: uncommitted changes; commit the source first or set ALLOW_DIRTY=1" >&2
  git -C "$SRC" status --short --untracked-files=no >&2
  exit 2
fi

REV_SHA="$(git -C "$SRC" rev-parse "$REV")"
CLEAN="$(mktemp -d -t shared-framing-release-XXXXXX)"
echo "clean dir: $CLEAN"
echo "source rev: $REV_SHA"

# Materialise the exact committed tree; nothing from the working dir (and
# nothing gitignored) leaks in.
git -C "$SRC" archive --format=tar "$REV" | tar -C "$CLEAN" -xf -

cd "$CLEAN"
echo "› npm install (clean)"
npm install --no-audit --no-fund >/dev/null

OUT="${RELEASE_OUT:-$CLEAN/evidence}"
echo "› release runner (clean)"
RELEASE_CLEAN_DIR=1 RELEASE_SOURCE_REV="$REV_SHA" \
  npx vite-node tools/release/run-release.ts -- --out "$OUT"
STATUS=$?

echo "clean evidence: $OUT"
if [ -z "${KEEP_CLEAN:-}" ]; then
  rm -rf "$CLEAN"
fi
exit $STATUS
