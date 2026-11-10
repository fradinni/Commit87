#!/usr/bin/env bash
# Builds the snap into dist/*.snap using snapcraft.
#
# snap/snapcraft.yaml uses project-relative paths and expects the unpacked Electron app
# at dist/snap-app, so this script stages the architecture-specific electron-builder
# output there before packing. The snap's version comes from package.json via
# scripts/sync-version.mjs; this script refuses to build if the two disagree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGE="dist/snap-app"

# Maps the host machine name to electron-builder's unpacked output directory.
unpacked_dir_for() {
  case "$1" in
    x86_64|amd64) echo "linux-unpacked" ;;
    aarch64|arm64) echo "linux-arm64-unpacked" ;;
    *) return 1 ;;
  esac
}

if ! command -v snapcraft >/dev/null 2>&1; then
  echo "snapcraft is required: sudo snap install snapcraft --classic" >&2
  exit 1
fi

ARCH="$(uname -m)"
UNPACKED="$(unpacked_dir_for "$ARCH")" || {
  echo "unsupported architecture: $ARCH" >&2
  exit 1
}
APP_DIR="dist/$UNPACKED"

VERSION="$(node -p "require('./package.json').version")"
YAML_VERSION="$(sed -n 's/^version:[[:space:]]*//p' snap/snapcraft.yaml | head -n1 | tr -d "\"'")"
if [ "$YAML_VERSION" != "$VERSION" ]; then
  echo "snap/snapcraft.yaml version ($YAML_VERSION) does not match package.json ($VERSION)" >&2
  echo "run: node scripts/sync-version.mjs" >&2
  exit 1
fi

echo "==> building the unpacked Electron app"
npm run pack:dir >/dev/null

if [ ! -f build/icons/512x512.png ]; then
  npm run icons
fi

if [ ! -d "$APP_DIR" ]; then
  echo "missing $APP_DIR; electron-builder did not write the $ARCH unpacked app" >&2
  exit 1
fi

mkdir -p dist
rm -rf "$STAGE"
cp -al "$APP_DIR" "$STAGE" 2>/dev/null || cp -a "$APP_DIR" "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

echo "==> snapcraft pack ($ARCH from $APP_DIR)"
snapcraft pack --destructive-mode

shopt -s nullglob
snaps=(./*.snap)
shopt -u nullglob
if [ "${#snaps[@]}" -eq 0 ]; then
  echo "snapcraft produced no .snap file" >&2
  exit 1
fi

SNAP_FILE="$(ls -t "${snaps[@]}" | head -n1)"
if [ ! -s "$SNAP_FILE" ]; then
  echo "snapcraft produced an empty file: $SNAP_FILE" >&2
  exit 1
fi

mv -f "$SNAP_FILE" dist/
BUILT="dist/$(basename "$SNAP_FILE")"
echo "built $BUILT ($(du -h "$BUILT" | cut -f1))"
