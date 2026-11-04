#!/bin/sh
# Flatpak entrypoint: Electron inside the sandbox cannot use the Chromium
# sandbox helper, and git/ssh live at /app within the runtime.
set -eu

export GITGROVE_FLATPAK=1
export PATH="/app/bin:/usr/bin:/bin"
export GIT_EXEC_PATH="/app/libexec/git-core"
export GIT_SSL_CAINFO="/etc/ssl/certs/ca-certificates.crt"

exec /app/gitgrove/gitgrove --no-sandbox "$@"