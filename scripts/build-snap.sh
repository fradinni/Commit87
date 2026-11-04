#!/usr/bin/env bash
# Builds the snap (dist/*.snap) using snapcraft.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v snapcraft >/dev/null 2>&1; then
  echo "snapcraft is required: sudo snap install snapcraft --classic" >&2
  exit 1
fi

echo "==> building the unpacked Electron app"
npm run pack:dir >/dev/null

if [ ! -f build/icons/512x512.png ]; then
  npm run icons
fi

VERSION="$(node -p "require('./package.json').version")"
sed -i "s/^version: .*/version: '${VERSION}'/" snap/snapcraft.yaml

echo "==> snapcraft pack"
snapcraft pack --destructive-mode
ls -la ./*.snap 2>/dev/null || true
echo "snap built"