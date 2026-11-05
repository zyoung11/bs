#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

out="${1:-dist}"
rm -rf "$out"
mkdir -p "$out"

cp -r src/* "$out/"
cp manifest.chrome.json "$out/manifest.json"

if [ "${2:-}" = "firefox" ]; then
  cp manifest.firefox.json "$out/manifest.json"
fi

echo "built $out"
