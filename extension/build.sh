#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

pack() {
  local dir="$1"
  local archive="$2"
  rm -f "$archive"
  (
    cd "$dir"
    7z a -tzip "../$archive" . >/dev/null
  )
}

rm -rf dist dist-firefox
mkdir -p dist dist-firefox

cp -r src/* dist/
cp manifest.chrome.json dist/manifest.json
pack dist bs.zip

cp -r src/* dist-firefox/
cp manifest.firefox.json dist-firefox/manifest.json
pack dist-firefox bs.xpi

echo "built dist and dist-firefox"
echo "packed bs.zip and bs.xpi"
