#!/usr/bin/env bash
# CI: assemble a draft, then publish it as a prerelease. Retries may replace draft assets.
# Requires GH_TOKEN and GH_REPO; never modifies an already published release.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
TAG="${1:-}"
[[ $# -eq 1 && "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a tag such as v0.2.0"
[[ -n "${GH_REPO:-}" ]] || die "GH_REPO must identify the release repository"
[[ -s build/F1TV.wgt && -s build/F1TV.wgt.sha256 ]] || die "build the package and checksum first"

ASSETS=(build/F1TV.wgt build/F1TV.wgt.sha256 build/F1TV-staging.wgt build/F1TV-staging.wgt.sha256 "build/bundle-${TAG#v}.tar" build/bundle.json build/bundle.json.sig)
for asset in "${ASSETS[@]}"; do [[ -s "$asset" ]] || die "missing release asset: $asset"; done

node scripts/verify-bundle.js build/bundle.json
node -e 'if (require("./build/bundle.json").version !== process.argv[1]) process.exit(1)' "${TAG#v}" || die "manifest version does not match tag"
(cd build && sha256sum --check F1TV.wgt.sha256 F1TV-staging.wgt.sha256)

if state="$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft --jq .isDraft)"; then
  [[ "$state" == true ]] || die "$TAG is already published; refusing to replace its assets"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$GH_REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --repo "$GH_REPO" \
    --draft --verify-tag --title "$TAG" --generate-notes
fi

# No assets may be changed after this transition.
gh release edit "$TAG" --repo "$GH_REPO" --draft=false --prerelease
