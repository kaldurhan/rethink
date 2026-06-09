#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>   e.g.  ./scripts/release.sh 1.0.2
# Bumps homeassistant/config.yaml, commits, pushes, and creates a GitHub release.
# The CI workflow then builds and publishes ghcr.io/kaldurhan/rethink:<version> + :latest.

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "Usage: $0 <version>  (e.g. 1.0.2)" >&2
    exit 1
fi

# Strip leading 'v' so config.yaml always stores bare semver
VERSION="${VERSION#v}"
TAG="v${VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG="${REPO_ROOT}/homeassistant/config.yaml"

# ── Guards ────────────────────────────────────────────────────────────────────

BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != "master" ]]; then
    echo "error: must be on master (currently on ${BRANCH})" >&2
    exit 1
fi

if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
    echo "error: working tree is not clean — commit or stash changes first" >&2
    exit 1
fi

# Fail if there are commits that haven't been pushed yet.
# All work must be on the remote before we tag — otherwise the release
# points at an older commit and the GHCR image is built from wrong code.
git -C "${REPO_ROOT}" fetch --quiet origin master
UNPUSHED="$(git -C "${REPO_ROOT}" rev-list origin/master..HEAD --count)"
if [[ "${UNPUSHED}" -gt 0 ]]; then
    echo "error: ${UNPUSHED} commit(s) not yet pushed to origin/master" >&2
    echo "       run 'git push' first, then re-run this script" >&2
    exit 1
fi

# ── Build + test ──────────────────────────────────────────────────────────────

echo "Building..."
npm --prefix "${REPO_ROOT}" run build

echo "Running tests..."
npm --prefix "${REPO_ROOT}" test

# ── Version bump ──────────────────────────────────────────────────────────────

sed -i "s/^version: .*/version: '${VERSION}'/" "${CONFIG}"

# Guard against sed silently producing an empty file (has happened before).
if [[ ! -s "${CONFIG}" ]]; then
    echo "error: homeassistant/config.yaml is empty after sed — aborting" >&2
    git -C "${REPO_ROOT}" checkout -- homeassistant/config.yaml
    exit 1
fi

echo "Bumped homeassistant/config.yaml → version: '${VERSION}'"

git -C "${REPO_ROOT}" add homeassistant/config.yaml
git -C "${REPO_ROOT}" commit -m "chore: bump add-on version to ${VERSION}"
git -C "${REPO_ROOT}" push

# ── GitHub release (triggers GHCR image build) ────────────────────────────────

gh release create "${TAG}" \
    --title "${TAG}" \
    --notes "Release ${TAG}" \
    --target master

echo ""
echo "Release ${TAG} created. CI will publish ghcr.io/kaldurhan/rethink:${VERSION} and :latest."
