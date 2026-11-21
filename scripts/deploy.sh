#!/usr/bin/env bash
# Build, sign and install the app on the TV.
#   scripts/deploy.sh cert      one-time: create signing certificate + security profile
#   scripts/deploy.sh build     package app/ into build/F1TV.wgt
#   UPDATES=off|stable|prerelease (development only; default off, local override wins)
#   scripts/deploy.sh install   connect to the TV, install and launch
#   scripts/deploy.sh           build + install
#   scripts/deploy.sh connect   connect sdb to the TV and print its sdb address
#   TV_JUMP=<ssh host>          reach the TV through that host (Developer Mode then points at its address)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
TIZEN="$TIZEN_HOME/tools/ide/bin/tizen"
SDB="$TIZEN_HOME/tools/sdb"
TV_IP="${TV_IP:-10.0.0.47}"
TV_JUMP="${TV_JUMP:-}"
JUMP_PORT="${JUMP_PORT:-36101}"
PROFILE="f1tv"
APP_ID="F1TVtizen1.F1TV"
PW_FILE="$ROOT/.cert-password"

# This PC's address on the TV's network (what Developer Mode must point at).
pc_ip() { ip -4 route get "$TV_IP" | sed -n 's/.* src \([0-9.]*\).*/\1/p'; }

# The TV's sdb address: the TV itself, or with TV_JUMP an SSH tunnel through that host, so the TV sees the
# jump host's address. The tunnel stays open in the background (one per jump host) for later calls.
tv_addr() {
  if [[ -z "$TV_JUMP" ]]; then echo "$TV_IP:26101"; return; fi
  local sock="${XDG_RUNTIME_DIR:-/tmp}/f1tv-sdb-$TV_JUMP.sock"
  if ! ssh -S "$sock" -O check "$TV_JUMP" >/dev/null 2>&1; then
    ssh -f -N -M -S "$sock" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
      -L "127.0.0.1:$JUMP_PORT:$TV_IP:26101" "$TV_JUMP" >&2 || { echo "no SSH tunnel through $TV_JUMP" >&2; return 1; }
  fi
  echo "127.0.0.1:$JUMP_PORT"
}

cmd_connect() {
  local addr; addr="$(tv_addr)"
  "$SDB" connect "$addr" >&2
  echo "$addr"
}

cmd_cert() {
  [[ -f "$PW_FILE" ]] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$PW_FILE"
  local pw; pw="$(cat "$PW_FILE")"
  # A new certificate means a new key, which installed TVs refuse as an update. Change details with
  # scripts/renew-author-cert.sh instead.
  if [[ -f "$HOME/tizen-studio-data/keystore/author/$PROFILE-author.p12" ]]; then
    echo "$PROFILE-author.p12 already exists; use scripts/renew-author-cert.sh to change it" >&2; exit 1
  fi
  "$TIZEN" certificate -a "$PROFILE" -p "$pw" -c NO -ct Oslo -o "$PROFILE" -n "$PROFILE" \
    -e f1tv@example.com -f "$PROFILE-author"
  "$TIZEN" security-profiles add -n "$PROFILE" \
    -a "$HOME/tizen-studio-data/keystore/author/$PROFILE-author.p12" -p "$pw"
  "$TIZEN" security-profiles set-active -n "$PROFILE" 2>/dev/null || true
}

cmd_build() {
  case "${UPDATES:-off}" in
    off|stable|prerelease) ;;
    *) echo 'UPDATES must be off, stable or prerelease' >&2; return 1 ;;
  esac
  rm -rf "$ROOT/build" && mkdir -p "$ROOT/build/src"
  # Apply personal bundle overrides before hashing; launcher-build.js is a shell override.
  local source; source="$(mktemp -d)"
  cp -r "${APP_SRC:-$ROOT/app}/." "$source/"
  if [[ "${RELEASE:-}" != 1 ]]; then
    [[ ! -f "$ROOT/local/icon.png" ]] || cp "$ROOT/local/icon.png" "$source/img/icon.png"
    [[ ! -f "$ROOT/local/logo.png" ]] || cp "$ROOT/local/logo.png" "$source/img/logo.png"
    [[ ! -d "$ROOT/local/app" ]] || cp -r "$ROOT/local/app/." "$source/"
  fi
  node "${BUILD_SCRIPT:-$ROOT/scripts/build-bundle.js}" "$source" "${SHELL_SRC:-$ROOT/shell}" "$ROOT/build"
  if [[ "${RELEASE:-}" != 1 ]]; then
    # Always disabled by default, including on a fresh clone without local/.
    node - "$ROOT/build/src/launcher-build.js" "${UPDATES:-off}" <<'JS'
const fs = require('fs');
const file = process.argv[2], mode = process.argv[3];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
  .replace('updates: true', 'updates: ' + (mode !== 'off'))
  .replace("channel: 'stable'", "channel: '" + (mode === 'prerelease' ? 'prerelease' : 'stable') + "'"));
JS
    [[ ! -f "$source/launcher-build.js" ]] || cp "$source/launcher-build.js" "$ROOT/build/src/launcher-build.js"
  fi
  mkdir -p "$source/package"
  "$TIZEN" package -t wgt -s "$PROFILE" -o "$source/package" -- "$ROOT/build/src"
  mv "$source/package/"*.wgt "$ROOT/build/F1TV.wgt"
  if [[ "${RELEASE:-}" == 1 ]]; then
    # Reuse the assembled bundle verbatim; only the root channel override changes.
    node - "$ROOT/build/src/launcher-build.js" <<'JS'
const fs = require('fs'), file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("channel: 'stable'", "channel: 'prerelease'"));
JS
    "$TIZEN" package -t wgt -s "$PROFILE" -o "$source/package" -- "$ROOT/build/src"
    mv "$source/package/"*.wgt "$ROOT/build/F1TV-staging.wgt"
    cp "${SHELL_SRC:-$ROOT/shell}/launcher-build.js" "$ROOT/build/src/launcher-build.js"
  fi
  rm -rf "$source"
  echo "Built $ROOT/build/F1TV.wgt"
}

cmd_install() {
  local addr; addr="$(cmd_connect)"
  local serial; serial="$("$SDB" devices | awk -v a="$addr" '$1 == a { print $3; exit }')"
  local host; if [[ -n "$TV_JUMP" ]]; then host="the address of $TV_JUMP"; else host="$(pc_ip)"; fi
  [[ -n "$serial" ]] || { echo "TV not found via sdb. Is Developer Mode on with host IP $host?"; exit 1; }
  "$TIZEN" install -n "$ROOT/build/F1TV.wgt" -t "$serial"
  "$TIZEN" run -p "$APP_ID" -t "$serial"
}

case "${1:-all}" in
  cert) cmd_cert ;;
  build) cmd_build ;;
  install) cmd_install ;;
  connect) cmd_connect ;;
  all) cmd_build; cmd_install ;;
  *) echo "usage: $0 [cert|build|install|connect]"; exit 1 ;;
esac
