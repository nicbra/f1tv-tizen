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
git rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null 2>&1 || die "tag $TAG does not exist"

VERSION="${TAG#v}"
git show "refs/tags/$TAG:app/config.xml" | python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.stdin)'
printf 'Validated %s; package version will be %s.\n' "$TAG" "$VERSION"
[[ "${2:-}" != --check ]] || exit 0

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive "refs/tags/$TAG" app | tar -x -C "$STAGE"
python3 - "$STAGE/app/config.xml" "$VERSION" <<'PY'
import sys
import xml.etree.ElementTree as ET

ET.register_namespace('', 'http://www.w3.org/ns/widgets')
ET.register_namespace('tizen', 'http://tizen.org/ns/widgets')
manifest = ET.parse(sys.argv[1], parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
manifest.getroot().set('version', sys.argv[2])
manifest.write(sys.argv[1], encoding='UTF-8', xml_declaration=True)
PY
APP_SRC="$STAGE/app" RELEASE=1 bash scripts/deploy.sh build
(
  cd build
  if command -v sha256sum >/dev/null; then sha256sum F1TV.wgt; else shasum -a 256 F1TV.wgt; fi > F1TV.wgt.sha256
)
printf 'Built build/F1TV.wgt and build/F1TV.wgt.sha256 from %s.\n' "$TAG"
