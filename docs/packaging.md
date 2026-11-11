# Packaging and distribution

## Matrix

| Platform | Format | Arch | Built by |
| --- | --- | --- | --- |
| Linux | AppImage | x64, arm64 | `electron-builder` (`linux.target`) |
| Linux | `.deb` | amd64, arm64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `.rpm` | x86_64, aarch64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `pacman` `.pkg.tar.xz` (electron-builder) / `.pkg.tar.zst` (script) | x86_64, aarch64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `tar.gz` | x64, arm64 | `electron-builder` |
| Linux | Snap | amd64, arm64 | `scripts/build-snap.sh` (local) |
| Linux | Flatpak | x86_64, aarch64 | `scripts/build-flatpak.sh` (local) |
| Windows | NSIS `.exe` | x64, arm64 | `electron-builder` on `windows-2022` |
| Windows | portable `.exe` | x64, arm64 | `electron-builder` |
| Windows | `.zip` | x64, arm64 | `electron-builder` |
| macOS | `.dmg` | x64, arm64 | `electron-builder` on `macos-15` (x64 cross-built) |
| macOS | `.zip` | x64, arm64 | `electron-builder` |

Artifacts land in `dist/`. CI uploads them per runner (`.github/workflows/ci.yml`) as
development builds: unsigned on Linux and Windows, ad-hoc signed only on macOS. A tag push or
manual release run (`.github/workflows/release.yml`) resolves one version and channel, builds
every `electron-builder` target with `--publish never`, verifies the assembled files, and only
then uploads them to the draft release. The release workflow attaches only the
`electron-builder` targets; Snap and Flatpak are built locally with the scripts above.

Every target produces one artifact per architecture; no platform emits a combined or
universal build. Artifact names always carry the architecture token (`x64`/`x86_64`/
`amd64` or `arm64`/`aarch64`), and Windows NSIS/portable use
`buildUniversalInstaller: false` so the arch-less combined installer and portable exe
are never produced.

## Platform support tiers

| Tier | Meaning | Formats |
| --- | --- | --- |
| **Supported** | Built and packaged by CI; Linux x64 and arm64 are packaged on the x64 runner (arm64 cross-packaged), Windows and macOS on their native runners. The app itself was launched only on Linux during this validation (see "Verification performed"). | Linux AppImage, `.deb`, `.rpm`, pacman and `tar.gz` from `electron-builder` (x64 and arm64); Windows NSIS/portable/zip; macOS `.dmg`/`.zip` |
| **Buildable** | Recipe is checked in and builds on a host with the tools, but this validation did not exercise it. | `scripts/package-linux.py` `.deb` and `.rpm` fallback (`ar`/`rpmbuild`) |
| **Experimental** | Optional format; its recipe is statically validated only, so packaging metadata may still change and no native build or install is claimed. | Flatpak (`scripts/build-flatpak.sh`), Snap (`scripts/build-snap.sh`), the pacman `.pkg.tar.zst` fallback |

The optional recipes were statically validated on 2026-11-10 with
`python3 scripts/check-package-recipes.py` only. That host has no `flatpak-builder` and no
`snapcraft`, so no Flatpak bundle, snap or fallback pacman archive was built or installed
during the validation. Build and install them on a machine with the matching toolchain,
and verify the result there, before promoting them beyond experimental support.

Windows and macOS packages are built and code-verified by CI on native runners (macOS also
checks the signature path described below), but no Windows or macOS installer or app was
launched during this validation, and no release was published. Their support tier therefore
rests on the build recipes, the platform toolchain checks and the workflow definition, not on
an exercised install or update.

## Update feeds

`electron-builder` writes update metadata next to the artifacts because `publish` points at
the GitHub repository: `latest.yml`/`beta.yml` on Windows,
`latest-linux.yml`/`beta-linux.yml` for the x64 AppImage,
`latest-linux-arm64.yml`/`beta-linux-arm64.yml` for the arm64 AppImage, and
`latest-mac.yml`/`beta-mac.yml` for the macOS zip. The Linux updater selects its feed by
architecture, so a release must carry both Linux metadata files; a missing arm64 file leaves
arm64 clients without an update. The app's updater reads the file named by the packaged
`app-update.yml`; the renderer never supplies a URL.

- The channel follows the resolved package version, never the branch: a version with a
  `-beta.N` suffix is a beta (pre-release) package, any other version is stable. Both the
  release workflow and `electron-builder.config.cjs` derive it from the version, so a beta
  package cannot publish `latest*` metadata; a contradicting `COMMIT87_RELEASE_CHANNEL`
  value fails the build instead of silently switching channels.
- Only `-beta.N` prereleases are accepted. `-rc.1` or `-alpha.1` tags fail the workflow
  because no client looks for their channel file.
- Stable tags publish as drafts until a maintainer promotes them. `-beta.N` tags publish as
  GitHub pre-releases, so `/releases/latest` keeps pointing at the last stable tag and
  stable installs stay put.
- A draft GitHub release is invisible to the updater. Promote a reviewed draft with
  `gh release edit v<version> --draft=false`. A beta draft is already flagged as a
  pre-release, so promoting it cannot make it the latest stable release.
- The macOS feed must include the `.zip` target next to the `.dmg`; the zip is what the
  updater downloads and swaps in.
- Ad-hoc macOS builds do not read these YAML feeds: their updater resolves the newest
  release from the GitHub releases API (matching the architecture's `mac-<arch>.zip` and
  the selected stable/beta channel), and `scripts/install-macos.sh` is attached to every
  release as the command-line installer for the same flow.

`electron-updater` is bundled into `out/main` by `electron-vite`, so the ASAR still ships
without `node_modules`.

## Release workflow

`.github/workflows/release.yml` runs on `v*` tags and on manual dispatch.

1. `prepare` resolves the release once with
   `node scripts/sync-version.mjs --resolve --github-output`. A tag push takes the version
   from the tag, a manual run from the checked-out `package.json`; the resolver rejects a
   tag/version mismatch, an unsupported prerelease and a non-boolean draft input. It emits
   `version`, `tag`, `channel`, `prerelease` and `draft` step outputs, and every later job
   reads those outputs instead of re-deriving them. The manual `draft` input is honoured
   for manual runs; tag pushes keep the tag rules above (stable drafts, beta pre-releases).
2. `prepare` also refuses a tag that already points at a different commit (so a manual run
   cannot attach its artifacts to an older tag), and stops when the tag lookup itself fails
   (403, 5xx, a network error) instead of assuming the tag is new: only an HTTP 404 counts
   as "tag absent". It creates the release as a **draft**, or clears the assets of an
   existing draft. A release that is already published is never overwritten.
3. `build` runs the matrix with `--publish never`: Linux x64 and arm64 in one invocation on
   `ubuntu-24.04` (arm64 is cross-packaged there, as in CI), and Windows plus macOS as one
   invocation per platform. Each platform's two architectures therefore share one build
   instead of overwriting each other's metadata: `<channel>.yml` on Windows,
   `<channel>-linux.yml` and `<channel>-linux-arm64.yml` on Linux, `<channel>-mac.yml` on
   macOS. Each job writes `SIGNING-STATUS-<target>.txt` and uploads its artifacts to the
   workflow run.
4. `publish` downloads every build artifact, then verifies before touching the release: each
   channel metadata file (`<channel>.yml`, `<channel>-linux.yml`,
   `<channel>-linux-arm64.yml`, `<channel>-mac.yml`) must exist, declare the resolved version
   and reference files that are present; each Linux metadata file must name an AppImage for
   its own architecture; metadata for another channel is rejected; both architectures of
   every target must be present; no artifact may be empty. It then writes
   `SHA256SUMS.txt`, `BUILD-INFO.txt` (version, channel, source commit and ref, workflow
   run) and `SIGNING-STATUS.txt`, uploads those with the artifacts, and finally applies the
   resolved draft/prerelease flags.

If any build or verification step fails, the release stays a draft with no new assets.

### Release authority

- The workflow is read-only by default (`permissions: contents: read`). Only `prepare` and
  `publish` have `contents: write`, and only their `gh` steps receive `GITHUB_TOKEN`.
- Packaging jobs get no repository token and no release permissions: they upload workflow
  artifacts only. Signing secrets are scoped to the platform build step that needs them
  (macOS certificate plus Apple notarization credentials, Windows certificate), so a Linux
  job never sees them.
- Checkouts use `persist-credentials: false`; nothing in the workflow pushes with the
  checkout credential.
- Third-party actions are pinned to the commit behind their `vN` tag (the trailing comment
  records the tag). When bumping one, resolve and review the new SHA before changing it.
- PR CI (`.github/workflows/ci.yml`) stays `contents: read`, gets no secrets, and packages
  unsigned development builds with `--publish never`.

## Build reliability

Packaging downloads the Electron runtime and electron-builder's toolsets from GitHub
releases. Those requests occasionally answer 5xx or drop the connection, which fails an
otherwise healthy build. CI handles that in two ways:

- The `package-*` jobs in `.github/workflows/ci.yml` and every job in the release matrix
  restore an `actions/cache` entry for electron-builder's download cache
  (`~/.cache/electron-builder` on Linux, `~/Library/Caches/electron-builder` on macOS,
  `~/AppData/Local/electron-builder/Cache` on Windows), keyed by the lockfile hash. It
  holds the Electron runtime zips and the toolsets (7zip, fpm, AppImage, NSIS), so a
  repeat build of the same dependency set needs no download at all.
- `scripts/build-packages.mts` wraps `electron-builder` and reruns the packaging step when
  it fails on a transport error (`Response code 5xx`, `ECONNRESET`, `ETIMEDOUT`,
  `ENOTFOUND`, `socket hang up`, a checksum mismatch, …), with exponential backoff.
  Configuration and build errors are not retried; they fail on the first attempt.
  `npm run build:linux`, `build:win`, `build:mac`, `build:all` and `pack:dir` use it too.

The defaults are four attempts waiting 20 s, 40 s and 80 s between them. Override them
with `BUILD_PACKAGES_ATTEMPTS`, `BUILD_PACKAGES_RETRY_DELAY_MS` (first delay in ms) and
`BUILD_PACKAGES_RETRY_MAX_DELAY_MS` (cap, default 120000).

## Linux packaging details

Building the container formats with `electron-builder` needs host tools that are not
always preinstalled:

- `fakeroot` and `rpm` (the bundled `fpm` drives both the deb and rpm paths)
- `bsdtar` (`libarchive-tools` on Debian/Ubuntu, `libarchive` on Fedora/Arch), which
  `fpm` invokes for the pacman `.MTREE` index. Without it the pacman target fails with
  exit code `127` after the AppImage, deb, rpm and tar.gz artifacts are already written.

```bash
sudo apt-get install -y fakeroot rpm libarchive-tools   # Debian/Ubuntu CI runners
sudo dnf install -y fakeroot rpm libarchive             # Fedora
sudo pacman -S --needed fakeroot rpm libarchive         # Arch
```

The `linux` release matrix and the CI `package-linux` job install these before
packaging. Alternatively, `scripts/package-linux.py` builds deb, rpm and pacman without
`fpm` and falls back to GNU `tar` when `bsdtar` is missing.

`electron-builder` derives the pacman artifact extension from the target name, which would
yield an untyped `.pacman` file. The pacman options override `artifactName` only; the xz
compression fpm uses by default stays, so CI and releases publish
`Commit87-<version>-linux-<arch>.pkg.tar.xz`.

All Linux packages install the app to `/opt/Commit87`, add `/usr/bin/commit87`,
`/usr/share/applications/commit87.desktop`, hicolor icons from 16 to 1024 px, and the
license. The wrapper is a one-line `exec /opt/Commit87/commit87 "$@"`, which keeps
`argv[0]` and working-directory behaviour predictable for deep links and file-manager
integration. The desktop entry registers `x-scheme-handler/commit87` and
`inode/directory`, so "Open With Commit87" is offered for folders; the file manager passes
a `file://` URL, which the launcher accepts alongside plain folder arguments.

Dependencies:

- Debian/Ubuntu: `git libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
  libatspi2.0-0 libsecret-1-0`, recommends `git-lfs`
- RPM: `git gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libsecret`
- pacman: `git gtk3 libnotify nss libxss libxtst xdg-utils at-spi2-core libsecret`

### `scripts/package-linux.py`

`electron-builder` shells out to a bundled `fpm` whose Ruby build expects
`libcrypt.so.1`. On distributions that only ship `libcrypt.so.2` (recent Fedora), `fpm`
cannot start, so this script builds the three container formats directly from the
unpacked app for the host architecture: `dist/linux-unpacked` on x86_64 and
`dist/linux-arm64-unpacked` on arm64.

- **deb**: `ar` archive with `debian-binary`, `control.tar.xz` (control, md5sums,
  postinst/postrm refreshing the desktop database) and `data.tar.xz`
- **rpm**: a generated spec (`AutoReqProv: no`, explicit `Requires:`, pre-release versions
  moved from `Version` to `Release`, post-install/removal desktop database refresh) built
  with `rpmbuild -bb` and `w9.xzdio` compression
- **pacman**: `.PKGINFO`, `.INSTALL` and a `zstd`-compressed tar whose entries, including
  the metadata, sit at the archive root. The archive is re-read after writing and the
  build fails if `.PKGINFO` is nested below a top-level directory or an unexpected
  top-level entry appears.

Deterministic timestamps come from `SOURCE_DATE_EPOCH` (default `1762300000`) so repeated
builds of the same inputs produce stable archives.

```bash
npm run pack:dir
python3 scripts/package-linux.py            # deb, rpm, pacman
python3 scripts/package-linux.py deb        # a single format
```

The script selects the unpacked directory from `os.uname().machine` and stops with the
expected path when the architecture-specific directory is missing. It prints size and
SHA-256 for every artifact.

### Snap

`snap/snapcraft.yaml` is `core24`, strict confinement, `commit87` app, with Git, git-lfs,
OpenSSH and CA certificates staged. Paths in it are relative to the project directory (the
parent of `snap/`), so they match the checked-in layout: `source: snap/local` for the
launcher part, `source: dist/snap-app` for the app and `icon: snap/gui/commit87.png`.

`scripts/build-snap.sh` stages the host architecture's unpacked app
(`dist/linux-unpacked` or `dist/linux-arm64-unpacked`) at `dist/snap-app` before calling
`snapcraft pack`, refuses to build when `snap/snapcraft.yaml` and `package.json` disagree
on the version, and moves the produced `.snap` into `dist/`.

The launcher (`snap/local/command.sh`) sets `GIT_EXEC_PATH`, `PATH`, `GIT_SSL_CAINFO` and
starts Electron with `--no-sandbox` (Chromium's sandbox cannot be used under strict
confinement). `ca-certificates` is staged and the prime list keeps `etc/ssl/certs`,
`usr/lib/ssl` and `usr/share/ca-certificates`, so the CA bundle the launcher points at
exists inside the snap. Plugs include `home`, `removable-media`,
`password-manager-service` and `ssh-keys`.

```bash
npm run dist:snap                         # builds dist/commit87_<version>_<arch>.snap
sudo snap install --dangerous dist/commit87_0.2.0-beta.5_amd64.snap
```

### Flatpak

`flatpak/fr.fradinni.Commit87.yml` uses the `org.freedesktop.Platform` 24.08 runtime with
`org.electronjs.Electron2.BaseApp`, builds Git 2.51.2 from source inside the sandbox, and
installs the unpacked Electron build to `/app/commit87`. Finish args grant `home`,
`removable-media`, wayland/X11, network, DRI, `~/.ssh:ro`, `xdg-run/gnupg:ro` and access to
the Secret Service.

The manifest declares `branch: stable` and `scripts/build-flatpak.sh` reads the app ID and
branch from it, passes the branch to `flatpak-builder` (`--default-branch`) and exports the
same ref with `flatpak build-bundle`. The script stages the host architecture's unpacked
app (`dist/linux-unpacked` or `dist/linux-arm64-unpacked`) at `dist/flatpak-app`, the
manifest's app source, because a Flatpak source path cannot expand the architecture; it
also fails if the bundle file was not written and names it from `package.json`.

```bash
npm run dist:flatpak                      # dist/Commit87-<version>-x86_64.flatpak
flatpak install --user dist/Commit87-0.2.0-beta.5-x86_64.flatpak
```

App ID: `fr.fradinni.Commit87`.

### Optional recipe static check

`python3 scripts/check-package-recipes.py` needs only the Python 3 standard library and
checks the recipes without building them:

- every local Flatpak `path:` and Snap `source:` resolves inside the repository.
  `dist/flatpak-app` and `dist/snap-app` pass only because the helper scripts stage the
  architecture-specific unpacked app there;
- the Flatpak app ID and branch come from the manifest, `flatpak-builder` builds that
  branch, `flatpak build-bundle` exports the same app ID/branch, and the bundle file is
  confirmed non-empty;
- Snap and Flatpak version fields match `package.json`, the single version source;
- the Snap prime list contains the CA certificate paths its launcher references;
- `build-flatpak.sh`, `build-snap.sh` and `package-linux.py` map `x86_64`/`amd64` to
  `linux-unpacked` and `aarch64`/`arm64` to `linux-arm64-unpacked`, reject unknown
  architectures and fail when that directory is missing;
- a fixture archive proves `.PKGINFO` and `.INSTALL` stay at the pacman archive root, and
  that the layout validator rejects an archive that nests them.

A `tar` without `--zstd` skips only the pacman fixture and is reported as skipped.

## Cold start and AppImage

The AppImage runtime mounts its squashfs image before any application code runs, so the
in-app splash cannot cover that phase. Everything after it is optimised:

- the main window is created as soon as Electron is ready, while the config store and Git
  identity detection run in the background; IPC requests wait on the router instead of
  delaying window creation;
- a small native splash window is shown until the renderer's first paint;
- `highlight.js` is loaded lazily with the file viewer instead of the initial graph view;
- the production `node_modules` tree is excluded from the ASAR because Vite already
  bundles every runtime dependency, shrinking `app.asar` from ~19 MB to ~1.5 MB;
- AppImages use `compression: 'normal'` (gzip) rather than `maximum` (xz): xz saves
  roughly 25 MB but adds decompression time to every launch. Use `deb`/`rpm` if the
  smallest on-disk artifact matters more than cold-start time.

Measure a build with the opt-in trace:

```bash
COMMIT87_STARTUP_TRACE=1 ./dist/Commit87-0.2.0-beta.5-linux-x86_64.AppImage
# [commit87:startup] main process loaded … +0ms
# [commit87:startup] app ready … +249ms
# [commit87:startup] main window ready … +1290ms
```

## Windows

- NSIS: per-user install, changeable directory, desktop and Start Menu shortcuts,
  uninstall entry, `asInvoker` execution level.
- Portable `.exe`: single self-extracting executable.
- `.zip`: unpacked directory.
- `buildUniversalInstaller: false` on both NSIS and portable, so each architecture
  produces its own `-win-x64-`/`-win-arm64-` file and no arch-less combined installer.
- `build/installer.nsh` only adds notices about the Git for Windows requirement.

Code signing uses `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`. The release workflow only sets
them in the Windows build step, from `WIN_CERT_P12` / `WIN_CERT_PASSWORD`. Without those
secrets the build is an **unsigned development build**: it runs, but Windows SmartScreen
warns and the release's `SIGNING-STATUS.txt` says it is unsigned. Production releases are
expected to configure the certificate; the workflow does not verify the signer identity, it
only records whether a certificate was used.

## macOS

- `.dmg` with a `/Applications` symlink and a `.zip` for tooling.
- `hardenedRuntime: true`, entitlements in `build/entitlements.mac.plist` (JIT,
  unsigned executable memory, network client, user-selected files, Apple events).
  These take effect when electron-builder signs with a Developer ID; ad-hoc fallback
  builds are intentionally plain ad-hoc.
- Notarization uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- Both architectures are packaged on `macos-15`: arm64 natively and Intel x64
  cross-built, because the Intel `macos-13` image is retired. They share
  `latest-mac.yml`, so the release workflow builds them in one invocation.

### Code signing and why unsigned builds must still be signed

Flipping the `electronFuses` options patches Electron's binaries, which invalidates the
ad-hoc signature the linker stamped on them at build time. When no Apple Developer ID
certificate is available (`MAC_CERT_P12` / `MAC_CERT_PASSWORD` unset), electron-builder
skips signing entirely and would leave the app with a broken signature. On Apple Silicon
macOS the kernel enforces signature validity and kills such an app at launch with
`SIGKILL (Code Signature Invalid)`, surfaced to the user as "the application is damaged".

`electronFuses.resetAdHocDarwinSignature: true` makes `@electron/fuses` re-sign the app
bundle ad-hoc right after the fuse patch, so the binaries always carry a valid signature.
When a Developer ID certificate is configured, electron-builder's own signing runs
afterwards and replaces the ad-hoc signature.

#### Production builds

A production macOS release is signed with a Developer ID Application certificate and
notarized (`MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`). electron-builder notarizes the app automatically once the Apple
credentials and a signing identity are present.

The release workflow checks the result before anything is published, for every produced
`.app`:

- `codesign --verify --deep --strict` must pass;
- `codesign -dv` must report an `Authority=Developer ID Application:` chain;
- the reported `TeamIdentifier` must equal `APPLE_TEAM_ID`, so a build signed by some other
  team fails;
- `spctl --assess --type execute` must accept the app, which fails for a Developer ID build
  that was not notarized.

A configured certificate without `APPLE_TEAM_ID` fails the job instead of shipping an
unverifiable production build. This verifies publisher identity and notarization acceptance;
it does not prove notarization of the `.dmg` container or a stapled ticket, and it is not
exercised in this repository's validation (see below).

#### Development and contributor fallback

Without the secrets a build is a **development/unsigned** build: ad-hoc signed and not
notarized. The release workflow then only proves the signature is internally valid
(`codesign --verify`), emits a warning, and writes `SIGNING-STATUS.txt` into the release
assets so the label travels with the artifact instead of living only in a job log. CI
(`package-macos`) does the same validity check on unsigned development packages.

Consequences for users:

- With signing secrets configured: a signed, notarized `.dmg`/`.zip` that Gatekeeper
  accepts directly.
- Without them: an ad-hoc signed build that runs cleanly when installed by
  `scripts/install-macos.sh`, which downloads the release with `curl` so the quarantine
  attribute never lands on the bundle. A `.dmg`/`.zip` downloaded by a browser is instead
  blocked by Gatekeeper until allowed in System Settings > Privacy & Security (macOS 15+
  removed the Control-click > Open shortcut, and the `xattr -dr com.apple.quarantine`
  workaround is unreliable on macOS 26; downloading through the script avoids the flag
  entirely). A fully clean experience still requires configuring the secrets above.

### macOS updates without a Developer ID

The in-app updater has two macOS paths, chosen by `main/mac-signing.ts`:

- **Developer ID builds** use electron-updater/Squirrel.Mac. Squirrel.Mac compares the
  downloaded bundle with the designated requirement of the running app; a Developer ID
  signature produces a requirement anchored to the certificate and team, which the next
  release also satisfies.
- **Ad-hoc builds** cannot use Squirrel.Mac: an ad-hoc signature embeds the current
  build's `cdhash`, so a later build would be rejected with:

  ```
  Code signature at URL … did not pass validation:
  code is not compliant with specified code requirements
  ```

  Instead `main/mac-script-updater.ts` implements the same state machine
  (`main/updates.ts`) with a self-contained flow: it resolves the newest release from the
  GitHub releases API, downloads the architecture's `mac-<arch>.zip` with `fetch`
  (again: no quarantine attribute), verifies its SHA-256 against the release's
  `SHA256SUMS.txt`, checks `codesign --verify --deep --strict`, reads the bundle's
  declared version, and stages it. **Restart & install** then detaches a small bash
  helper that waits for the app to quit, swaps the bundle in place (backup first,
  restored on failure), re-clears quarantine, re-verifies the signature and relaunches.
  Progress, release notes and the stable/beta channel behave exactly like the other
  formats, so Settings > Updates needs no macOS-specific UI.

`scripts/install-macos.sh` is the command-line twin of that flow and is attached to every
macOS release. It detects the architecture, resolves the newest release, downloads with
`curl`, verifies `SHA256SUMS.txt` and the code signature, installs to `~/Applications`
(`--system` for `/Applications`) and is idempotent, so re-running it is how command-line
users update. It is also how a first install avoids the Gatekeeper step above.

Configure `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID` to switch macOS back to the Squirrel.Mac path, where the update feed
(`latest-mac.yml`/`beta-mac.yml`) is used again.

The ad-hoc path was exercised against the real `v0.2.0-beta.9` release on macOS 26.5.1
(Apple M5 Pro): `scripts/install-macos.sh` installed, updated and removed the app in a
throwaway directory and in `~/Applications`; the in-app adapter resolved the beta release,
downloaded the zip, verified its SHA-256 against the release `SHA256SUMS.txt`, extracted it
with `ditto`, passed `codesign --verify --deep --strict` and the bundle-version cross-check,
and its detached swap helper replaced the bundle and relaunched it. Signed/notarized macOS
releases and the push-installed UI behaviour still require their native signers and a
release run.

## Icons

`build/icon.svg` is the single source of truth. `npm run icons` rasterises 16–1024 px PNGs
with ImageMagick, assembles a multi-resolution `icon.ico`, and produces `icon.icns`
(either with `iconutil`/`png2icns` when present, or via `scripts/make-icns.py`, which writes
the ICNS container with PNG chunks for `ic07`–`ic14`).

## Versioning

One version source: `package.json`. `node scripts/sync-version.mjs [version]` rewrites
`src/main/version.ts`, `snap/snapcraft.yaml` and adds the Flatpak metainfo release entry.

Release runs do not guess the version or channel. `node scripts/sync-version.mjs --resolve`
prints the single resolution (`version`, `tag`, `channel`, `prerelease`, `draft`), and
`--github-output` writes the same values to step outputs:

```bash
node scripts/sync-version.mjs --resolve --tag v0.2.0-beta.6        # tag push
node scripts/sync-version.mjs --resolve --draft false              # manual run from package.json
```

Rules:

- a tag push takes the version from the tag; a manual run takes the checked-out
  `package.json` version; passing both requires them to agree;
- only `x.y.z` and `x.y.z-beta.N` are accepted, and anything else fails before a release is
  prepared;
- `channel` is `beta` for a prerelease and `latest` otherwise, `prerelease` matches the
  beta channel, and `draft` follows the manual `draft` input, defaulting to a draft.

The release workflow passes the resolved version to `sync-version.mjs` in every build job,
so `APP_VERSION`, `package.json`, the channel metadata and the draft/prerelease flags all
describe the same build.

## Verification performed for this repository

Artifacts below were built and inspected from an earlier `0.1.0` tree on Fedora 44 x86_64;
they record what was exercised then, not a claim about the current version.

| Artifact | Result |
| --- | --- |
| `Commit87-0.1.0-linux-x86_64.AppImage` (94 MB) | builds; app launches |
| `Commit87-0.1.0-linux-x64.tar.gz` (116 MB) | builds |
| `Commit87-0.1.0-amd64.deb` (82 MB) | `ar` members and control fields verified |
| `Commit87-0.1.0-x86_64.rpm` (79 MB) | `rpm -qip` / `rpm -qlp` verified, no duplicate entries |
| `Commit87-0.1.0-x86_64.pkg.tar.zst` (109 MB) | `.PKGINFO` and tree verified |
| `dist/linux-unpacked` | launches and loads the renderer from the ASAR |

Snap and Flatpak are assembled locally with the scripts above, not in CI, and were not
built on this host: their recipes are covered by `scripts/check-package-recipes.py`, which
is why the support tiers above keep them experimental until a native build and install is
recorded. Windows and macOS artifacts require their native toolchains and are produced by
CI on the matching runners.

The release flow itself was validated statically: both workflow files parse as YAML, the
artifact-verification step was exercised against a synthetic `dist/` fixture for the
`latest` and `beta` metadata names (including missing, empty, wrong-version, wrong-channel,
missing arm64 feed and arm64-feed-names-the-x64-package cases), and
`scripts/sync-version.mjs --resolve` was exercised for stable tags, beta tags, unsupported
prereleases, tag/version mismatches and the manual draft input. A local
`--linux AppImage --x64 --arm64 --publish never` run (electron-builder 26.18.0) produced
`Commit87-0.2.0-beta.5-linux-x86_64.AppImage` with `beta-linux.yml` and
`Commit87-0.2.0-beta.5-linux-arm64.AppImage` with `beta-linux-arm64.yml` in one output
directory, and that real metadata pair passed the verification step; the arm64 AppImage was
built but not launched. No GitHub Actions run, packaging upload, code signing or
notarization was performed here; those require the hosted runners and the repository
secrets, so the signed/notarized path and the native Windows/macOS runtime remain
unverified until a release run records them.