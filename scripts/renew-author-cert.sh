#!/usr/bin/env bash
# Reissue the Tizen author certificate with new details (email, name) and a new validity, keeping its private key.
#
#   scripts/renew-author-cert.sh EMAIL [NAME]
#
# Samsung TVs compare only the author key when a package is updated (checked on a QE55Q77A, Tizen 6,
# 2026-11-15): a package signed with the reissued certificate installs over the old one and keeps the
# login and settings. A certificate from `tizen certificate` (or `scripts/deploy.sh cert`) has a NEW key:
# the TV refuses it ("Author certificate not match"), and every user would have to uninstall first.
# The TV also accepts expired author certificates, so the validity is only informational.
#
# The certificate is issued by the Tizen Studio developer CA, whose key ships with the SDK (it is how
# `tizen certificate` works offline). The new .p12 keeps the password in .cert-password; the old one is
# kept next to it. Afterwards update the TIZEN_AUTHOR_CERT_BASE64 secret (docs/RELEASING.md).
# AUTHOR_P12=<file> works on another copy (tests).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMAIL="${1:?usage: scripts/renew-author-cert.sh EMAIL [NAME]}"
NAME="${2:-f1tv-tizen}"
P12="${AUTHOR_P12:-$HOME/tizen-studio-data/keystore/author/f1tv-author.p12}"
PW_FILE="$ROOT/.cert-password"
CA_DIR="${TIZEN_HOME:-$HOME/tizen-studio}/tools/certificate-generator/certificates/developer"

[[ -f "$P12" ]] || { echo "No author certificate at $P12" >&2; exit 1; }
[[ -f "$PW_FILE" ]] || { echo "No password file at $PW_FILE" >&2; exit 1; }
[[ -f "$CA_DIR/tizen-developer-ca.cer" && -f "$CA_DIR/tizen-developer-ca-privatekey.pem" ]] || {
  echo "Tizen developer CA not found in $CA_DIR (set TIZEN_HOME)" >&2; exit 1; }

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# Older SDKs write the .p12 with RC2, which OpenSSL 3 reads only with -legacy.
p12() { openssl pkcs12 "$@" </dev/null 2>/dev/null || openssl pkcs12 -legacy "$@" </dev/null; }
p12 -in "$P12" -passin "file:$PW_FILE" -nocerts -nodes -out "$work/key.pem"
p12 -in "$P12" -passin "file:$PW_FILE" -clcerts -nokeys -out "$work/old.pem"
sed -n 's/^PASSWD_OF_ISSUER_FOR_DEV=//p' "$CA_DIR/conf.ini" | tr -d '\r\n' > "$work/ca.pw"

printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=codeSigning\n' > "$work/ext.cnf"
openssl req -new -key "$work/key.pem" -subj "/C=NO/L=Oslo/O=$NAME/emailAddress=$EMAIL/CN=$NAME" \
  -out "$work/req.csr" </dev/null
openssl x509 -req -in "$work/req.csr" -CA "$CA_DIR/tizen-developer-ca.cer" \
  -CAkey "$CA_DIR/tizen-developer-ca-privatekey.pem" -passin "file:$work/ca.pw" \
  -set_serial "0x$(openssl rand -hex 8)" -days 3650 -sha512 -extfile "$work/ext.cnf" \
  -out "$work/new.pem" </dev/null 2>/dev/null

key_of() { openssl x509 -in "$1" -pubkey -noout | openssl sha256; }
[[ "$(key_of "$work/old.pem")" == "$(key_of "$work/new.pem")" ]] || { echo "Key changed: refusing" >&2; exit 1; }

# 3DES/SHA-1 is what the SDK's Java signer reads.
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/new.pem" -certfile "$CA_DIR/tizen-developer-ca.cer" \
  -name usercertificate -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "file:$PW_FILE" -out "$work/new.p12" </dev/null

backup="$P12.$(date +%Y%m%d-%H%M%S).bak"
cp -p "$P12" "$backup"
install -m 600 "$work/new.p12" "$P12"
echo "Old certificate: $(openssl x509 -in "$work/old.pem" -noout -subject -enddate | tr '\n' ' ')"
echo "New certificate: $(openssl x509 -in "$work/new.pem" -noout -subject -enddate | tr '\n' ' ')"
echo "Same key. Wrote $P12 (old one kept as $backup)."
echo "Update the TIZEN_AUTHOR_CERT_BASE64 secret: base64 -w0 \"$P12\""
