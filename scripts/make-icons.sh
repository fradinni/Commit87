#!/usr/bin/env bash
# Generates every icon format electron-builder and the Linux packagers need.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/build/icon.svg"
OUT="$ROOT/build"
mkdir -p "$OUT/icons"

if ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick (convert) is required to rasterise build/icon.svg" >&2
  exit 1
fi

# Linux icon theme sizes
for size in 16 24 32 48 64 128 256 512 1024; do
  convert -background none -density 384 "$SRC" -resize "${size}x${size}" "$OUT/icons/${size}x${size}.png"
done

cp "$OUT/icons/512x512.png" "$OUT/icon.png"
convert -background none -density 384 "$SRC" -resize 1024x1024 "$OUT/icon-1024.png"

# Windows .ico (multi-resolution)
convert "$OUT/icons/256x256.png" "$OUT/icons/128x128.png" "$OUT/icons/64x64.png" \
  "$OUT/icons/48x48.png" "$OUT/icons/32x32.png" "$OUT/icons/16x16.png" "$OUT/icon.ico"

# macOS .icns
ICONSET="$OUT/icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for pair in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" "256 128x128@2x" \
            "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
  src_size="${pair%% *}"
  name="${pair##* }"
  cp "$OUT/icons/${src_size}x${src_size}.png" "$ICONSET/icon_${name}.png"
done
if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
elif command -v png2icns >/dev/null 2>&1; then
  png2icns "$OUT/icon.icns" "$ICONSET"/*.png
else
  echo "iconutil/png2icns missing; building the icns container directly"
  python3 "$ROOT/scripts/make-icns.py"
fi
rm -rf "$ICONSET"

echo "Icons written to $OUT (icons/, icon.png, icon.ico, icon.icns)"