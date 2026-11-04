#!/bin/sh
# Snap launcher. Electron's Chromium sandbox is blocked by strict confinement,
# so the packaged binary is started with --no-sandbox, as most Electron snaps do.
set -eu

export GITGROVE_SNAP=1
export GIT_EXEC_PATH="${SNAP}/usr/lib/git-core"
export PATH="${SNAP}/usr/bin:${PATH}"
export GIT_SSL_CAINFO="${SNAP}/etc/ssl/certs/ca-certificates.crt"
export LD_LIBRARY_PATH="${SNAP}/usr/lib:${SNAP}/usr/lib/${SNAP_ARCH:-x86_64}-linux-gnu${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

exec "${SNAP}/usr/lib/gitgrove/gitgrove" --no-sandbox "$@"