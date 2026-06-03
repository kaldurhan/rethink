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

# Sanity check: must be on master, tree must be clean
BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != "master" ]]; then
    echo "error: must be on master (currently on ${BRANCH})" >&2
    exit 1
fi

if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
    echo "error: working tree is not clean — commit or stash changes first" >&2
    exit 1
fi

# Bump version in homeassistant/config.yaml
sed -i "s/^version: .*/version: '${VERSION}'/" "${CONFIG}"

echo "Bumped homeassistant/config.yaml → version: '${VERSION}'"

git -C "${REPO_ROOT}" add homeassistant/config.yaml
git -C "${REPO_ROOT}" commit -m "chore: bump add-on version to ${VERSION}"
git -C "${REPO_ROOT}" push

gh release create "${TAG}" \
    --title "${TAG}" \
    --notes "Release ${TAG}" \
    --target master

echo ""
echo "Release ${TAG} created. CI will publish ghcr.io/kaldurhan/rethink:${VERSION} and :latest."
