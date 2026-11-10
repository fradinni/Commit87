#!/usr/bin/env bash
# Builds a Flatpak bundle (.flatpak) or installs into the local flatpak repo.
#
#   scripts/build-flatpak.sh            -> dist/Commit87-<version>-<arch>.flatpak
#   scripts/build-flatpak.sh --install  -> install into the current user
#
# Requires flatpak-builder and the org.freedesktop.Sdk 24.08 / Electron base app.
#
# The manifest is the single source for the app ID and the branch; the script reads
# both from it instead of repeating literals. It also stages the architecture-specific
# electron-builder output at dist/flatpak-app, which is the directory the manifest
# declares, because flatpak-builder cannot expand %{arch} in a source path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST="flatpak/fr.fradinni.Commit87.yml"
STAGE="dist/flatpak-app"

# Maps the host machine name to electron-builder's unpacked output directory.
unpacked_dir_for() {
  case "$1" in
    x86_64|amd64) echo "linux-unpacked" ;;
    aarch64|arm64) echo "linux-arm64-unpacked" ;;
    *) return 1 ;;
  esac
}

manifest_value() {
  sed -n "s/^$1:[[:space:]]*//p" "$MANIFEST" | head -n1 | tr -d "\"'"
}

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "flatpak-builder is required (flatpak install flathub org.flatpak.Builder)" >&2
  exit 1
fi

ARCH="$(uname -m)"
UNPACKED="$(unpacked_dir_for "$ARCH")" || {
  echo "unsupported architecture: $ARCH" >&2
  exit 1
}
APP_DIR="dist/$UNPACKED"

case "$ARCH" in
  x86_64|amd64) FLATPAK_ARCH=x86_64 ;;
  aarch64|arm64) FLATPAK_ARCH=aarch64 ;;
esac

APP_ID="$(manifest_value app-id)"
BRANCH="$(manifest_value branch)"
if [ -z "$APP_ID" ] || [ -z "$BRANCH" ]; then
  echo "$MANIFEST must declare app-id and branch" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"

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
rm -rf "$STAGE" dist/flatpak-repo
cp -al "$APP_DIR" "$STAGE" 2>/dev/null || cp -a "$APP_DIR" "$STAGE"
trap 'rm -rf "$STAGE" dist/flatpak-build' EXIT

flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08 || true

echo "==> flatpak-builder ($FLATPAK_ARCH, branch $BRANCH)"
flatpak-builder --force-clean --user --repo=dist/flatpak-repo \
  --arch="$FLATPAK_ARCH" --default-branch="$BRANCH" \
  dist/flatpak-build "$MANIFEST"

BUNDLE="dist/Commit87-${VERSION}-${FLATPAK_ARCH}.flatpak"
flatpak build-bundle --arch="$FLATPAK_ARCH" dist/flatpak-repo "$BUNDLE" "$APP_ID" "$BRANCH"

if [ ! -s "$BUNDLE" ]; then
  echo "flatpak build-bundle did not produce $BUNDLE" >&2
  exit 1
fi

echo "built $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  flatpak install --user -y "$BUNDLE"
  echo "installed $APP_ID"
fi
