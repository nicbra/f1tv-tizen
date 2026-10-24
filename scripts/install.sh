#!/usr/bin/env bash
# Install or update F1 TV from Linux or macOS. Requires curl and unzip.
#
#   curl -fsSL https://raw.githubusercontent.com/nicbra/f1tv-tizen/HEAD/scripts/install.sh | bash
#   bash install.sh [TV address] [--force] [--check] [--wgt F1TV.wgt]
#
#   TV address  skip the network search (TV: Settings > General > Network > Network Status)
#   --force     reinstall even if the TV already has this version
#   --check     only check the TV and download, don't install
#   --wgt FILE  install this package instead of the latest GitHub release
#
# Enable Developer Mode with this computer as Host PC IP (see README).
# No pipefail: several pipes end in head/awk that stop reading early, and outputs are checked instead.
set -eu

REPO="${F1TV_REPO:-nicbra/f1tv-tizen}"
APP_ID="F1TVtizen1.F1TV"
SDB_VERSION="4.2.36"
SDB_BASE="https://download.tizen.org/sdk/tizenstudio/official/binary"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/f1tv-tizen"
CURL_API=(curl -fsSL --connect-timeout 15 --max-time 60)
CURL_GET=(curl -fL --connect-timeout 15 --speed-limit 1024 --speed-time 30 --progress-bar)

TV="" WGT="" FORCE=0 CHECK=0 VERSION="" SDB="" SERIAL=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nError: %b\n' "$*" >&2; exit 1; }
# Read from the terminal when invoked through curl | bash.
ask()  { local a=""; printf '%s' "$1" > /dev/tty; read -r a < /dev/tty || true; printf '%s' "$a"; }

usage() {
  say "Usage: install.sh [TV address] [--force] [--check] [--wgt F1TV.wgt]"
  say "Installs or updates the F1 TV app on a Samsung TV in Developer Mode."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --wgt) [ $# -ge 2 ] || die "--wgt needs a file"; WGT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 1 ;;
    *) TV="$1"; shift ;;
  esac
done

for t in curl unzip; do command -v "$t" >/dev/null || die "'$t' is not installed."; done

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# First value of "key": "value" in a JSON text (enough for the flat answers used here).
field() { printf '%s\n' "$1" | sed -n "s/.*\"$2\" *: *\"\([^\"]*\)\".*/\1/p" | head -1; }

# Samsung's sdb tool

sdb_platform() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo ubuntu-64 ;;
    Darwin-x86_64) echo macos-64 ;;
    Darwin-arm64)
      # Samsung only ships an Intel build for macOS; Apple Silicon runs it through Rosetta 2.
      arch -x86_64 /usr/bin/true 2>/dev/null ||
        die "Samsung's sdb tool needs Rosetta on this Mac. Install it with:\n  softwareupdate --install-rosetta --agree-to-license\nthen run this again."
      echo macos-64 ;;
    *) die "Samsung's sdb tool isn't available for $(uname -s) $(uname -m). Use a Windows PC, a Mac or a 64-bit Intel/AMD Linux PC." ;;
  esac
}

get_sdb() {
  local plat want zip dir
  plat="$(sdb_platform)"
  dir="$CACHE/sdb-$SDB_VERSION-$plat"
  SDB="$dir/sdb"
  [ -x "$SDB" ] && return
  case "$plat" in
    ubuntu-64) want=addf825e1a886a9f220cb3d287e74438cae0ffafe5821b9baca9d4f6c7de5124 ;;
    macos-64) want=0bd307ac8382c857be5c2106dd5b8587b10c1c91ac1e504de8432c8276bc28c5 ;;
  esac
  step "Downloading Samsung's sdb tool $SDB_VERSION"
  mkdir -p "$dir"
  zip="$dir/sdb.zip"
  "${CURL_GET[@]}" -o "$zip" "$SDB_BASE/sdb_${SDB_VERSION}_$plat.zip" || die "Downloading sdb failed."
  [ "$(sha256 "$zip")" = "$want" ] || { rm -f "$zip"; die "The sdb download doesn't match its checksum."; }
  unzip -qjo "$zip" data/tools/sdb -d "$dir"
  rm -f "$zip"
  chmod +x "$SDB"
}

# finding the TV

# Samsung TVs describe themselves (name, model, developer mode) at http://<tv>:8001/api/v2/.
tv_info() { curl -s -m "${2:-3}" "http://$1:8001/api/v2/" 2>/dev/null || true; }

describe() {
  local j; j="$(tv_info "$1")"
  printf '%s (%s) at %s' "$(field "$j" name)" "$(field "$j" modelName)" "$1"
}

# Search the default route's network before other interfaces (including VMs and Docker).
local_ips() {
  local ifc
  if command -v ip >/dev/null; then
    ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'
    ip -4 -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }'
  else
    ifc="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
    [ -n "$ifc" ] && ipconfig getifaddr "$ifc" 2>/dev/null
    ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2 }'
  fi | awk 'NF && !seen[$0]++'
}

# Scan local /24 networks; stop at the first one with a TV.
find_tvs() {
  local ip net found
  for ip in $(local_ips); do
    case "$ip" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;; *) continue ;; esac
    net="${ip%.*}"
    found="$(seq 1 254 | xargs -P 64 -I{} sh -c \
      'r=$(curl -s -m 1 "http://$0.{}:8001/api/v2/" 2>/dev/null) && case "$r" in *SmartTV*) echo "$0.{}" ;; esac' "$net" | sort -u)"
    if [ -n "$found" ]; then printf '%s\n' "$found"; return; fi
  done
}

choose_tv() {
  [ -n "$TV" ] && return
  step "Looking for Samsung TVs on your network"
  local found n i line pick
  found="$(find_tvs || true)"
  n="$(printf '%s' "$found" | grep -c . || true)"
  if [ "$n" -eq 1 ]; then
    TV="$found"
    say "Found $(describe "$TV")"
  elif [ "$n" -gt 1 ]; then
    i=0
    while IFS= read -r line; do i=$((i + 1)); say "  $i) $(describe "$line")"; done <<EOF
$found
EOF
    pick="$(ask "Which TV? [1-$n]: ")"
    case "$pick" in ''|*[!0-9]*) die "No TV chosen." ;; esac
    TV="$(printf '%s\n' "$found" | sed -n "${pick}p")"
  else
    say "No TV answered. Make sure it is on and on the same network as this computer."
    TV="$(ask "Type the TV's IP address (TV: Settings > General > Network > Network Status): ")"
  fi
  [ -n "$TV" ] || die "No TV address given."
}

# The address this computer uses to reach the TV (what Developer Mode must allow).
my_ip_for() {
  if command -v ip >/dev/null; then
    ip -4 route get "$1" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'
  else
    local ifc; ifc="$(route -n get "$1" 2>/dev/null | awk '/interface:/ { print $2 }')"
    [ -n "$ifc" ] && ipconfig getifaddr "$ifc" 2>/dev/null || true
  fi
}

DEVMODE_HELP="On the TV: open Apps, press 1 2 3 4 5 on the remote (or the on-screen keypad), switch
Developer mode On, enter this computer's IP address as Host PC IP, then restart the TV
(hold the power button until it turns off and on again)."

check_tv() {
  local j mode host me
  me="$(my_ip_for "$TV")"
  j="$(tv_info "$TV")"
  if [ -z "$j" ]; then
    say "The TV at $TV didn't describe itself; trying to connect anyway."
    return
  fi
  mode="$(field "$j" developerMode)"
  host="$(field "$j" developerIP)"
  [ "$mode" = 1 ] || die "Developer Mode is off on the TV.\n$DEVMODE_HELP\nThis computer's address is ${me:-shown in your network settings}."
  if [ -n "$me" ] && [ -n "$host" ] && [ "$host" != "$me" ]; then
    die "The TV's Developer Mode allows $host, but this computer is $me.\n$DEVMODE_HELP"
  fi
}

# the app package

wgt_version() {
  unzip -p "$1" config.xml 2>/dev/null | tr '\n' ' ' | sed -n 's/.*<widget\([^>]*\)>.*/\1/p' |
    sed -n 's/.* version="\([^"]*\)".*/\1/p'
}

get_wgt() {
  if [ -n "$WGT" ]; then
    [ -f "$WGT" ] || die "$WGT doesn't exist."
    VERSION="$(wgt_version "$WGT")"
    return
  fi
  step "Looking up the latest release of $REPO"
  local api url sumurl want
  api="$("${CURL_API[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")" ||
    die "Couldn't get the latest release from GitHub ($REPO)."
  VERSION="$(field "$api" tag_name)"
  VERSION="${VERSION#v}"
  url="$(printf '%s\n' "$api" | sed -n 's/.*"browser_download_url" *: *"\([^"]*\/F1TV\.wgt\)".*/\1/p' | head -1)"
  sumurl="$(printf '%s\n' "$api" | sed -n 's/.*"browser_download_url" *: *"\([^"]*\/F1TV\.wgt\.sha256\)".*/\1/p' | head -1)"
  [ -n "$url" ] && [ -n "$sumurl" ] || die "The latest release ($VERSION) has no F1TV.wgt and F1TV.wgt.sha256."
  WGT="$CACHE/F1TV-$VERSION.wgt"
  if [ -f "$WGT" ]; then return; fi
  say "Downloading F1 TV $VERSION"
  mkdir -p "$CACHE"
  "${CURL_GET[@]}" -o "$WGT.part" "$url" || die "Downloading the app failed."
  want="$("${CURL_API[@]}" "$sumurl")" || die "Downloading the checksum failed."
  want="${want%% *}"
  [ "$(sha256 "$WGT.part")" = "$want" ] || { rm -f "$WGT.part"; die "The app download doesn't match its checksum."; }
  mv "$WGT.part" "$WGT"
}

# talking to the TV

# Returns tr's status, so callers must inspect the output. install_app checks push separately.
run_sdb() { "$SDB" -s "$SERIAL" "$@" 2>&1 | tr -d '\r'; }

connect() {
  SERIAL="$TV:26101"
  step "Connecting to the TV"
  "$SDB" start-server >/dev/null 2>&1 || true
  "$SDB" connect "$SERIAL" >/dev/null 2>&1 || true
  "$SDB" devices 2>/dev/null | tr -d '\r' | grep -q "^$SERIAL[[:space:]]*device" ||
    die "The TV didn't accept the connection.\n$DEVMODE_HELP"
}

installed_version() {
  run_sdb shell 0 vd_applist | awk -v id="$APP_ID" '
    /app_id[[:space:]]*=/ { mine = index($0, "=" id "-") > 0 }
    mine && /app_version[[:space:]]*=/ { v = $0; sub(/.*=/, "", v); sub(/-+$/, "", v); print v; exit }'
}

install_app() {
  local dir remote out answer
  dir="$(run_sdb capability | sed -n 's/^sdk_toolpath://p')"
  remote="${dir:-/home/owner/share/tmp/sdk_tools}/tmp/F1TV.wgt"
  step "Installing F1 TV $VERSION"
  "$SDB" -s "$SERIAL" push "$WGT" "$remote" >/dev/null 2>&1 || die "Copying the app to the TV failed."
  out="$(run_sdb shell 0 vd_appinstall "$APP_ID" "$remote")"
  case "$out" in
    *"install completed"*) say "Installed." ;;
    *[Cc]ertificate*chain*|*"118, -12"*)
      die "This TV only accepts apps signed with a Samsung certificate made for it (newer models do).\nBuild and sign the app yourself instead; see 'Building it yourself' in the README.\n\nThe TV said: $out" ;;
    *[Aa]uthor*|*[Ss]ignature*|*"118, -11"*)
      say "The TV has a copy of the app that was signed by someone else (for example a build of your own)."
      answer="$(ask "Remove it and install this version? You will need to sign in again. [y/N]: ")"
      case "$answer" in [yY]*) ;; *) die "Nothing changed." ;; esac
      run_sdb shell 0 vd_appuninstall "$APP_ID" >/dev/null
      out="$(run_sdb shell 0 vd_appinstall "$APP_ID" "$remote")"
      case "$out" in *"install completed"*) say "Installed." ;; *) die "The TV refused the app:\n$out" ;; esac ;;
    *) die "The TV refused the app:\n$out" ;;
  esac
}

launch() {
  local out
  out="$(run_sdb shell 0 execute "$APP_ID")"
  case "$out" in *[Ff]ail*|*rror*|*"not found"*) out="$(run_sdb shell 0 was_execute "$APP_ID")" ;; esac
  case "$out" in
    *[Ff]ail*|*rror*|*"not found"*) say "Open F1 TV from the TV's Apps." ;;
    *) say "F1 TV is starting on the TV." ;;
  esac
}

finish() {
  [ -n "$SDB" ] && [ -x "$SDB" ] && { "$SDB" disconnect "$SERIAL" >/dev/null 2>&1 || true; "$SDB" kill-server >/dev/null 2>&1 || true; }
}

main() {
  choose_tv
  check_tv
  get_sdb
  get_wgt
  trap finish EXIT
  connect
  local have
  have="$(installed_version)"
  say "On the TV: ${have:-not installed}. Available: $VERSION."
  if [ "$CHECK" = 1 ]; then say "Check only: nothing installed."; return; fi
  if [ -n "$have" ] && [ "$have" = "$VERSION" ] && [ "$FORCE" = 0 ]; then
    say "Already up to date (use --force to reinstall)."
  else
    install_app
  fi
  launch
}

main
