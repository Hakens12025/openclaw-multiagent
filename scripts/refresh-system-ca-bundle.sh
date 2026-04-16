#!/bin/bash

set -euo pipefail

TARGET_PATH="${1:-$HOME/.openclaw/certs/system-roots.pem}"
TARGET_DIR="$(dirname "$TARGET_PATH")"
TMP_PATH="${TARGET_PATH}.tmp"

mkdir -p "$TARGET_DIR"

security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$TMP_PATH"
mv "$TMP_PATH" "$TARGET_PATH"
chmod 0644 "$TARGET_PATH"

echo "$TARGET_PATH"
