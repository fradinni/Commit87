#!/bin/sh
# Snap launcher. Electron's Chromium sandbox is blocked by strict confinement,
# so the packaged binary is started with --no-sandbox, as most Electron snaps do.
set -eu

# SNAP_ARCH is a Debian architecture name (amd64/arm64); the multiarch library
# directory uses the GNU triplet instead.
case "${SNAP_ARCH:-amd64}" in
  amd64) TRIPLET=x86_64-linux-gnu ;;
  arm64) TRIPLET=aarch64-linux-gnu ;;
  armhf) TRIPLET=arm-linux-gnueabihf ;;
  *) TRIPLET="${SNAP_ARCH}-linux-gnu" ;;
esac

export COMMIT87_SNAP=1
export GIT_EXEC_PATH="${SNAP}/usr/lib/git-core"
export PATH="${SNAP}/usr/bin:${PATH}"
# ca-certificates is staged and primed by snap/snapcraft.yaml (etc/ssl/certs).
export GIT_SSL_CAINFO="${SNAP}/etc/ssl/certs/ca-certificates.crt"
export LD_LIBRARY_PATH="${SNAP}/usr/lib:${SNAP}/usr/lib/${TRIPLET}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

exec "${SNAP}/usr/lib/commit87/commit87" --no-sandbox "$@"
