#!/usr/bin/env bash
#
# Commit87 — macOS installer/updater (no Developer ID required)
#
# Downloads the release archive with curl (which never attaches the
# com.apple.quarantine attribute), verifies its SHA-256 against the
# SHA256SUMS.txt published on the same release, checks the code signature,
# installs the app and can update an existing copy in place.
#
# Because the archive is downloaded by this script rather than by a browser,
# its files never receive the quarantine attribute that makes ad-hoc signed
# builds hang at _dyld_start on macOS 15+; nothing about the script itself is
# blocked because it is interpreted by bash, not executed as a downloaded
# binary. The same flow powers the in-app updater for ad-hoc builds.
#
# Requirements (all shipped with macOS): bash, curl, unzip, shasum, codesign,
# osascript, python3 (used only to resolve the newest release from the GitHub
# API; `--version` pins a tag and skips it).
#
# Usage:
#   bash install-macos.sh                 install the newest release, or update
#   bash install-macos.sh --check         print the newest available version
#   bash install-macos.sh --uninstall     remove the installed copy
#   bash install-macos.sh --channel stable   follow stable releases only
#   bash install-macos.sh --channel beta     include prerelease builds
#   bash install-macos.sh --version v0.2.0-beta.9   install an exact tag
#   bash install-macos.sh --to /Applications        install somewhere else
#   bash install-macos.sh --system        install to /Applications
#   bash install-macos.sh --keep-work     keep downloaded files for inspection
#
# `latest` and `beta` include prereleases; `stable` excludes them.
#
# Exit codes: 0 success / nothing to do, 1 run-time error, 2 usage error.

set -euo pipefail

OWNER=fradinni
REPO=Commit87
PRODUCT=${PRODUCT:-Commit87}
API_URL="https://api.github.com/repos/${OWNER}/${REPO}/releases"
DOWNLOAD_ROOT="https://github.com/${OWNER}/${REPO}/releases/download"
VERSION_REGEX='^v?[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'

# ---------------------------------------------------------------------------
# Terminal helpers
# ---------------------------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  if command -v tput >/dev/null 2>&1 && tput setaf 1 >/dev/null 2>&1; then
    C_BOLD=$(tput bold)
    C_GREEN=$(tput setaf 2)
    C_YELLOW=$(tput setaf 3)
    C_RED=$(tput setaf 1)
    C_RESET=$(tput sgr0)
  fi
fi
C_BOLD=${C_BOLD:-} C_GREEN=${C_GREEN:-} C_YELLOW=${C_YELLOW:-} C_RED=${C_RED:-} C_RESET=${C_RESET:-}

say() { printf '%s\n' "${C_GREEN}==>${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}warning:${C_RESET} $*" >&2; }
die() { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; exit 1; }
usage_error() { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; exit 2; }
usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

need_value() {
  (($# >= 2)) || usage_error "$1 requires a value"
}

MODE=install
CHANNEL=latest
PINNED_TAG=
INSTALL_DIR=
KEEP_WORK=false

while (($#)); do
  case "$1" in
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    --update) MODE=install ;;
    --channel) need_value "$@"; CHANNEL="$2"; shift ;;
    --version) need_value "$@"; PINNED_TAG="$2"; shift ;;
    --to) need_value "$@"; INSTALL_DIR="$2"; shift ;;
    --system) INSTALL_DIR=/Applications ;;
    --keep-work) KEEP_WORK=true ;;
    --help | -h) usage ;;
    install | check | uninstall) MODE="$1" ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

case "$CHANNEL" in
  stable | beta | latest) ;;
  *) usage_error "invalid channel '$CHANNEL' (expected stable, beta or latest)" ;;
esac

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [[ -n "$PINNED_TAG" ]]; then
  [[ "$PINNED_TAG" =~ $VERSION_REGEX ]] || usage_error "invalid version '$PINNED_TAG' (expected e.g. v0.2.0 or v0.2.0-beta.9)"
fi

# ---------------------------------------------------------------------------
# Release resolution — prints three lines: version, zip asset, published date.
# python3 resolves the API JSON; it is present whenever Xcode command line
# tools are installed, and a pinned tag bypasses it entirely.
# ---------------------------------------------------------------------------

resolve_latest() {
  local ver asset
  if [[ -n "$PINNED_TAG" ]]; then
    ver=${PINNED_TAG#v}
    printf '%s\n%s\n%s\n' "$ver" "${PRODUCT}-${ver}-mac-${ARCH}.zip" ""
    return
  fi
  command -v python3 >/dev/null 2>&1 || die "'python3' is required to find the newest release (or pin one with --version)."

  local json status
  json=$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: commit87-installer' "${API_URL}?per_page=100" \
    2>/dev/null) || status=$?
  if [[ -z "${json:-}" ]]; then
    [[ "${status:-}" == 22 ]] && die "no matching release found for channel '$CHANNEL'; try --version"
    die "could not reach the GitHub API (curl exit ${status:-unknown})"
  fi

  local filter
  if [[ "$CHANNEL" == stable ]]; then
    filter='stable'
  else
    filter="${CHANNEL}"
  fi

  local out json_file
  # The release list (bodies, assets) can reach hundreds of KB, so the JSON is
  # passed by file name, not argv: macOS ARG_MAX would otherwise break this as
  # the release history grows. The caller creates and removes the file so an
  # interrupt can clean it even while the command substitution runs.
  json_file="$FEED_FILE"
  printf '%s' "$json" > "$json_file"
  out=$(CHECK_CHANNEL="$filter" CHECK_ARCH="$ARCH" python3 - "$json_file" <<'PY'
import json, os, re, sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    raw = fh.read()
try:
    data = json.loads(raw)
except Exception:
    sys.exit(9)
if not isinstance(data, list):
    sys.exit(9)
channel = os.environ["CHECK_CHANNEL"]
arch = os.environ["CHECK_ARCH"]
pattern = re.compile(r"^Commit87-[0-9].*-mac-" + re.escape(arch) + r"\.zip$")
version_pattern = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$")

def version_key(tag):
    match = version_pattern.match(tag or "")
    if not match:
        return None
    major, minor, patch, beta = match.groups()
    # A stable release sorts above any beta of the same version.
    return (int(major), int(minor), int(patch), 1 if beta is None else 0, int(beta or 0))

# The API sorts by creation time, not semantic version, so a backport published
# after a newer release can come first. Compare every match and keep the highest.
best = None
for release in data:
    if release.get("draft", False):
        continue
    key = version_key(release.get("tag_name", ""))
    if key is None:
        continue
    # The tag shape, not the API's prerelease flag, decides the channel so both
    # updaters agree on what a stable release is.
    if channel == "stable" and key[3] == 0:
        continue
    for asset in release.get("assets", []) or []:
        if pattern.match(asset.get("name", "")):
            if best is None or key > best[0]:
                best = (key, release, asset)
            break

if best is not None:
    print(best[1]["tag_name"].lstrip("v"))
    print(best[2]["name"])
    print(best[1].get("published_at", "") or "")
    sys.exit(0)
sys.exit(10)
PY
) || {
    local code=$?
    rm -f "$json_file"
    [[ $code -eq 9 ]] && die "unexpected response from the GitHub API; pin the version with --version"
    [[ $code -eq 10 ]] && die "no ${ARCH} ${PRODUCT} build found on channel '$CHANNEL'"
    die "failed to resolve the newest release"
  }
  rm -f "$json_file"

  printf '%s\n' "$out"
}

# ---------------------------------------------------------------------------
# Installed copy detection
# ---------------------------------------------------------------------------

INSTALLED_VERSION=
INSTALLED_PATH=

find_installed() {
  local base="${1:-}"
  [[ -d "$base/Commit87.app" ]] || return 0
  INSTALLED_PATH="$base/Commit87.app"
  INSTALLED_VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' \
    "$base/Commit87.app/Contents/Info.plist" 2>/dev/null || true)
}

if [[ -n "$INSTALL_DIR" ]]; then
  find_installed "$INSTALL_DIR"
else
  find_installed "$HOME/Applications"
  [[ -n "$INSTALLED_PATH" ]] || find_installed /Applications
fi

# Semver comparison for the only prerelease shape this project publishes
# (x.y.z-beta.N). A stable release is newer than any beta of itself.
version_gt() {
  local av bv a b amaj amin apatch abeta bmaj bmin bpatch bbeta arest brest
  av=${1#v}; bv=${2#v}
  a=${av%%-*}; b=${bv%%-*}
  amaj=${a%%.*}; arest=${a#*.}; amin=${arest%%.*}; apatch=${arest#*.}
  bmaj=${b%%.*}; brest=${b#*.}; bmin=${brest%%.*}; bpatch=${brest#*.}
  abeta=0; bbeta=0
  [[ "$av" == *-beta.* ]] && abeta=${av##*-beta.}
  [[ "$bv" == *-beta.* ]] && bbeta=${bv##*-beta.}
  abeta=${abeta//[^0-9]/}; bbeta=${bbeta//[^0-9]/}
  abeta=${abeta:-0}; bbeta=${bbeta:-0}
  if ((amaj != bmaj)); then return $((amaj > bmaj ? 0 : 1)); fi
  if ((amin != bmin)); then return $((amin > bmin ? 0 : 1)); fi
  if ((apatch != bpatch)); then return $((apatch > bpatch ? 0 : 1)); fi
  if [[ "$av" != *-beta.* && "$bv" == *-beta.* ]]; then return 0; fi
  if [[ "$av" == *-beta.* && "$bv" != *-beta.* ]]; then return 1; fi
  if ((abeta != bbeta)); then return $((abeta > bbeta ? 0 : 1)); fi
  return 1
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

quit_app() {
  if ! pgrep -x "$PRODUCT" >/dev/null 2>&1; then
    return
  fi
  pkill -x "$PRODUCT" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    pgrep -x "$PRODUCT" >/dev/null 2>&1 || return 0
    sleep 1
  done
  if pgrep -x "$PRODUCT" >/dev/null 2>&1; then
    die "${PRODUCT} is still running; quit it manually and try again. The installed app was not changed."
  fi
}

if [[ "$MODE" == uninstall ]]; then
  if [[ -z "$INSTALLED_PATH" ]]; then
    echo "${PRODUCT} is not installed in ${INSTALL_DIR:-$HOME/Applications or /Applications}; nothing to do."
    exit 0
  fi
  say "Quitting ${PRODUCT}…"
  quit_app
  say "Removing ${INSTALLED_PATH}"
  rm -rf "$INSTALLED_PATH"
  echo "done. The app was removed; your repositories, identities and settings were kept."
  exit 0
fi

# The feed copy is created in the main shell so its cleanup traps stay active
# even while resolve_latest runs inside a command substitution.
FEED_FILE=$(mktemp "${TMPDIR:-/tmp}/commit87-releases.XXXXXX")
trap 'rm -f "${FEED_FILE:-}"' EXIT
trap 'rm -f "${FEED_FILE:-}"; exit 130' INT
trap 'rm -f "${FEED_FILE:-}"; exit 143' TERM HUP
RELEASE_INFO=$(resolve_latest)
rm -f "$FEED_FILE"
FEED_FILE=
trap - INT TERM HUP
LATEST_VERSION=$(printf '%s\n' "$RELEASE_INFO" | sed -n '1p')
ZIP_NAME=$(printf '%s\n' "$RELEASE_INFO" | sed -n '2p')
PUBLISHED_AT=$(printf '%s\n' "$RELEASE_INFO" | sed -n '3p')

if [[ -z "$LATEST_VERSION" || -z "$ZIP_NAME" ]]; then
  die "could not resolve a ${ARCH} release"
fi

if [[ "$MODE" == check ]]; then
  echo "${PRODUCT}: local ${INSTALLED_VERSION:-not installed} · newest ${LATEST_VERSION} (${ZIP_NAME})"
  if [[ -n "$INSTALLED_VERSION" ]]; then
    if version_gt "$LATEST_VERSION" "$INSTALLED_VERSION"; then
      echo "status: update available"
    else
      echo "status: up to date"
    fi
  else
    echo "status: not installed"
  fi
  exit 0
fi

# install / update ----------------------------------------------------------

if [[ -n "$INSTALLED_VERSION" ]]; then
  if [[ -n "$PINNED_TAG" ]]; then
    say "Installing requested ${PRODUCT} ${LATEST_VERSION} (replacing ${INSTALLED_VERSION})"
  elif version_gt "$LATEST_VERSION" "$INSTALLED_VERSION"; then
    say "Updating ${PRODUCT} ${INSTALLED_VERSION} → ${LATEST_VERSION}"
  else
    echo "${PRODUCT} ${INSTALLED_VERSION} is already the newest release (${LATEST_VERSION})."
    exit 0
  fi
else
  say "Installing ${PRODUCT} ${LATEST_VERSION}"
fi

# The install target must match where the current copy was found, otherwise a
# user who once installed to /Applications would get a second copy in
# ~/Applications and a misleading "Updating" message.
if [[ -n "$INSTALL_DIR" ]]; then
  BASE_DIR="$INSTALL_DIR"
elif [[ -n "$INSTALLED_PATH" ]]; then
  BASE_DIR=$(dirname "$INSTALLED_PATH")
else
  BASE_DIR="$HOME/Applications"
fi
mkdir -p "$BASE_DIR"
TMP_BASE=${TMPDIR:-/tmp}
WORK=$(mktemp -d "${TMP_BASE%/}/commit87-install.XXXXXX")
STAGE=
BACKUP_DIR=
BACKUP=
INSTALL_PENDING=false
TARGET="$BASE_DIR/Commit87.app"

restore_previous() {
  # The move-aside operation may itself have failed or been interrupted before
  # moving anything. In that case the target is still the original app.
  if [[ -n "$BACKUP" && ! -e "$BACKUP" && ! -L "$BACKUP" ]]; then
    INSTALL_PENDING=false
    return 0
  fi
  # Never move the backup into an existing directory: mv would nest it inside
  # the broken replacement instead of restoring the installed bundle.
  if [[ -e "$TARGET" || -L "$TARGET" ]]; then
    if ! mv "$TARGET" "$STAGE/failed-Commit87.app"; then
      warn "could not move the failed replacement aside at ${TARGET}; previous copy kept at ${BACKUP:-not installed}"
      return 1
    fi
  fi
  if [[ -n "$BACKUP" ]]; then
    if ! mv "$BACKUP" "$TARGET"; then
      warn "could not restore the previous copy; it is kept at ${BACKUP}"
      return 1
    fi
    say "Restored the previous ${PRODUCT} at ${TARGET}"
  fi
  INSTALL_PENDING=false
}

cleanup() {
  local status=$?
  if [[ "$INSTALL_PENDING" == true ]]; then
    restore_previous || true
  fi
  if [[ "$KEEP_WORK" == false ]]; then
    rm -rf "$WORK"
    [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  fi
  # A backup that could not be restored is recovery data, never temporary trash.
  if [[ -n "$BACKUP_DIR" && ! -e "$BACKUP" && ! -L "$BACKUP" ]]; then
    rmdir "$BACKUP_DIR" 2>/dev/null || true
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Downloading ${ZIP_NAME}…"
ZIP_PATH="$WORK/$ZIP_NAME"
curl -fL --retry 3 --retry-delay 2 -o "$ZIP_PATH" \
  "${DOWNLOAD_ROOT}/v${LATEST_VERSION}/${ZIP_NAME}" || die "download failed: ${ZIP_NAME}"
[[ -s "$ZIP_PATH" ]] || die "download produced an empty file"

say "Verifying SHA-256 checksum…"
SUMS_PATH="$WORK/SHA256SUMS.txt"
curl -fsSL --retry 2 -o "$SUMS_PATH" \
  "${DOWNLOAD_ROOT}/v${LATEST_VERSION}/SHA256SUMS.txt" || die "download failed: SHA256SUMS.txt"
EXPECTED=$(awk -v name="$ZIP_NAME" '$2 == name { print $1 }' "$SUMS_PATH" || true)
[[ -n "$EXPECTED" ]] || die "'$ZIP_NAME' has no entry in the release SHA256SUMS.txt"
ACTUAL=$(shasum -a 256 "$ZIP_PATH" | awk '{ print $1 }')
[[ "$ACTUAL" == "$EXPECTED" ]] || die "checksum mismatch for $ZIP_NAME (refusing to install a corrupted download)"

say "Extracting…"
# Extract and verify on the destination filesystem before touching the current
# app. The final swap is a rename, never a cross-volume partial copy.
STAGE=$(mktemp -d "${BASE_DIR%/}/.commit87-install.XXXXXX")
mkdir -p "$STAGE/app"
unzip -q "$ZIP_PATH" -d "$STAGE/app" 2>/dev/null || ditto -x -k "$ZIP_PATH" "$STAGE/app"
APP_PATH="$STAGE/app/Commit87.app"
[[ -d "$APP_PATH" ]] || die "the archive does not contain Commit87.app"

APP_VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' \
  "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "")
if [[ -n "$APP_VERSION" && "$APP_VERSION" != "$LATEST_VERSION" ]]; then
  die "archive declares version $APP_VERSION but release v$LATEST_VERSION was requested"
fi

say "Checking code signature…"
if ! codesign --verify --deep --strict --verbose=1 "$APP_PATH" 2>/dev/null; then
  die "the ${PRODUCT} bundle failed its code-signature check"
fi

# The archive came from curl, so no file inside it carries the quarantine
# attribute. Clear it anyway in case a previous step staged a copy.
xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true

say "Quitting any running ${PRODUCT} instance…"
quit_app

if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  BACKUP_DIR=$(mktemp -d "${BASE_DIR%/}/.commit87-backup.XXXXXX")
  BACKUP="$BACKUP_DIR/Commit87.app"
  say "Replacing ${TARGET}"
  INSTALL_PENDING=true
  mv "$TARGET" "$BACKUP" || die "could not move aside the current ${PRODUCT}"
fi
INSTALL_PENDING=true
if ! mv "$APP_PATH" "$TARGET"; then
  die "could not install ${PRODUCT} into ${BASE_DIR}"
fi
xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
if ! codesign --verify --deep --strict --verbose=1 "$TARGET" 2>/dev/null; then
  die "the installed ${PRODUCT} failed its code-signature check"
fi
INSTALL_PENDING=false
if [[ -n "$BACKUP_DIR" ]]; then
  rm -rf "$BACKUP_DIR"
fi

say "Launching ${PRODUCT} ${LATEST_VERSION}"
open -n "$TARGET"
echo
echo "${C_GREEN}Done.${C_RESET}"
echo "${PRODUCT} ${LATEST_VERSION} is installed in ${TARGET}."
if [[ "$CHANNEL" == latest && "$LATEST_VERSION" == *-beta.* ]]; then
  warn "this is a prerelease build. The in-app updater defaults to the stable channel, so it will offer the same releases only after Settings → Updates is switched to the Beta channel; use --channel stable to follow stable releases only."
fi
