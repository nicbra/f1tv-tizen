#!/usr/bin/env bash
# Build, sign and install the app on the TV.
#   scripts/deploy.sh cert      one-time: create signing certificate + security profile
#   scripts/deploy.sh build     package app/ into build/F1TV.wgt
#   scripts/deploy.sh install   connect to the TV, install and launch
#   scripts/deploy.sh           build + install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
TIZEN="$TIZEN_HOME/tools/ide/bin/tizen"
SDB="$TIZEN_HOME/tools/sdb"
TV_IP="${TV_IP:-10.0.0.47}"
PROFILE="f1tv"
APP_ID="F1TVtizen1.F1TV"
PW_FILE="$ROOT/.cert-password"

# This PC's address on the TV's network (what Developer Mode must point at).
pc_ip() { ip -4 route get "$TV_IP" | sed -n 's/.* src \([0-9.]*\).*/\1/p'; }

cmd_cert() {
  [[ -f "$PW_FILE" ]] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$PW_FILE"
  local pw; pw="$(cat "$PW_FILE")"
  "$TIZEN" certificate -a "$PROFILE" -p "$pw" -c NO -ct Oslo -o "$PROFILE" -n "$PROFILE" \
    -e f1tv@example.com -f "$PROFILE-author"
  "$TIZEN" security-profiles add -n "$PROFILE" \
    -a "$HOME/tizen-studio-data/keystore/author/$PROFILE-author.p12" -p "$pw"
  "$TIZEN" security-profiles set-active -n "$PROFILE" 2>/dev/null || true
}

cmd_build() {
  rm -rf "$ROOT/build" && mkdir -p "$ROOT/build/src"
  cp -r "$ROOT/app/." "$ROOT/build/src/"
  "$TIZEN" package -t wgt -s "$PROFILE" -o "$ROOT/build" -- "$ROOT/build/src"
  mv "$ROOT/build/"*.wgt "$ROOT/build/F1TV.wgt"
  echo "Built $ROOT/build/F1TV.wgt"
}

cmd_install() {
  "$SDB" connect "$TV_IP:26101"
  local serial; serial="$("$SDB" devices | awk -v ip="$TV_IP" 'index($1, ip) { print $3; exit }')"
  [[ -n "$serial" ]] || { echo "TV not found via sdb - is Developer Mode on with host IP $(pc_ip)?"; exit 1; }
  "$TIZEN" install -n "$ROOT/build/F1TV.wgt" -t "$serial"
  "$TIZEN" run -p "$APP_ID" -t "$serial"
}

case "${1:-all}" in
  cert) cmd_cert ;;
  build) cmd_build ;;
  install) cmd_install ;;
  all) cmd_build; cmd_install ;;
  *) echo "usage: $0 [cert|build|install]"; exit 1 ;;
esac
