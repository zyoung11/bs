#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
root="$(pwd)"

rm -rf dist dist-firefox
rm -f dist.zip bs.xpi

mkdir -p dist
cp -r src/* dist/
cp manifest.chrome.json dist/manifest.json

firefox_tmp="$(mktemp -d)"
cp -r src/* "$firefox_tmp"/
cp manifest.firefox.json "$firefox_tmp"/manifest.json
(
  cd "$firefox_tmp"
  7z a -tzip "$root/bs.xpi" . >/dev/null
)
rm -rf "$firefox_tmp"

7z a -tzip dist.zip dist >/dev/null

echo "built dist"
echo "packed dist.zip and bs.xpi"
