#!/usr/bin/env bash
# Promote a tested published prerelease without rebuilding or replacing assets.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
TAG="${1:-}"
[[ $# -eq 1 && "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a tag such as v0.2.0"
[[ -n "${GH_REPO:-}" ]] || die "GH_REPO must identify the release repository"

release="$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft,isPrerelease,assets)" || die "$TAG does not exist or could not be read"
printf '%s' "$release" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("isDraft") is not False or r.get("isPrerelease") is not True:
    sys.exit("Release must be a published prerelease before promotion")
expected = {"F1TV.wgt", "F1TV.wgt.sha256", "bundle-" + sys.argv[1] + ".tar", "bundle.json", "bundle.json.sig"}
missing = expected - {a["name"] for a in r.get("assets", [])}
if missing:
    sys.exit("Missing release assets: " + ", ".join(sorted(missing)))
' "${TAG#v}"
gh release edit "$TAG" --repo "$GH_REPO" --prerelease=false --latest
