#!/usr/bin/env bash
# CI: create a draft release, or replace assets on an existing draft after a retry.
# Requires GH_TOKEN and GH_REPO; never modifies an already published release.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
TAG="${1:-}"
[[ $# -eq 1 && "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a tag such as v0.2.0"
[[ -n "${GH_REPO:-}" ]] || die "GH_REPO must identify the release repository"
[[ -s build/F1TV.wgt && -s build/F1TV.wgt.sha256 ]] || die "build the package and checksum first"

if state="$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft --jq .isDraft)"; then
  [[ "$state" == true ]] || die "$TAG is already published; refusing to replace its assets"
  gh release upload "$TAG" build/F1TV.wgt build/F1TV.wgt.sha256 --repo "$GH_REPO" --clobber
else
  gh release create "$TAG" build/F1TV.wgt build/F1TV.wgt.sha256 --repo "$GH_REPO" \
    --draft --verify-tag --title "F1 TV ${TAG#v}" --generate-notes
fi
