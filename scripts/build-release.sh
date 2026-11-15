#!/usr/bin/env bash
# Build the committed app from a version tag, stamping that version into the package only.
#   scripts/build-release.sh v0.2.0 [--check]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/build-release.sh v<version> [--check]"
[[ $# -eq 1 || ( $# -eq 2 && "$2" == --check ) ]] || die "usage: scripts/build-release.sh v<version> [--check]"
TAG_COMMIT="$(git rev-parse --verify "refs/tags/$TAG^{commit}")" || die "tag $TAG does not exist"
COMMIT="${RELEASE_COMMIT:-$TAG_COMMIT}"
[[ "$TAG_COMMIT" == "$COMMIT" ]] || die "tag $TAG no longer points to the tested commit"

VERSION="${TAG#v}"
git show "$COMMIT:app/config.xml" | python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.stdin)'
printf 'Validated %s; package version will be %s.\n' "$TAG" "$VERSION"
[[ "${2:-}" != --check ]] || exit 0

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive "$COMMIT" app shell scripts | tar -x -C "$STAGE"
python3 - "$STAGE/app/config.xml" "$VERSION" <<'PY'
import sys
import xml.etree.ElementTree as ET

ET.register_namespace('', 'http://www.w3.org/ns/widgets')
ET.register_namespace('tizen', 'http://tizen.org/ns/widgets')
manifest = ET.parse(sys.argv[1], parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
manifest.getroot().set('version', sys.argv[2])
manifest.write(sys.argv[1], encoding='UTF-8', xml_declaration=True)
PY
APP_SRC="$STAGE/app" SHELL_SRC="$STAGE/shell" BUILD_SCRIPT="$STAGE/scripts/build-bundle.js" RELEASE=1 bash scripts/deploy.sh build
(
  cd build
  for package in F1TV.wgt F1TV-staging.wgt; do
    if command -v sha256sum >/dev/null; then sha256sum "$package"; else shasum -a 256 "$package"; fi > "$package.sha256"
  done
)
printf 'Built stable/staging packages, checksums and unsigned bundle assets from %s.\n' "$TAG"
