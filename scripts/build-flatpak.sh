#!/usr/bin/env bash
# Builds a Flatpak bundle (.flatpak) or installs into the local flatpak repo.
#
#   scripts/build-flatpak.sh            -> dist/Commit87-<version>-x86_64.flatpak
#   scripts/build-flatpak.sh --install  -> install into the current user
#
# Requires flatpak-builder and the org.freedesktop.Sdk 24.08 / Electron base app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "flatpak-builder is required (flatpak install flathub org.flatpak.Builder)" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) FLATPAK_ARCH=x86_64 ;;
  aarch64|arm64) FLATPAK_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

echo "==> building the unpacked Electron app"
npm run pack:dir >/dev/null

if [ ! -f build/icons/512x512.png ]; then
  npm run icons
fi

flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08 || true

mkdir -p dist
echo "==> flatpak-builder ($FLATPAK_ARCH)"
flatpak-builder --force-clean --user --repo=dist/flatpak-repo \
  --arch="$FLATPAK_ARCH" dist/flatpak-build flatpak/fr.fradinni.Commit87.yml

flatpak build-bundle dist/flatpak-repo \
  "dist/Commit87-${VERSION}-${FLATPAK_ARCH}.flatpak" \
  fr.fradinni.Commit87 stable

echo "built dist/Commit87-${VERSION}-${FLATPAK_ARCH}.flatpak"

if [ "${1:-}" = "--install" ]; then
  flatpak install --user -y "dist/Commit87-${VERSION}-${FLATPAK_ARCH}.flatpak"
  echo "installed fr.fradinni.Commit87"
fi