# Packaging and distribution

## Matrix

| Platform | Format | Arch | Built by |
| --- | --- | --- | --- |
| Linux | AppImage | x64, arm64 | `electron-builder` (`linux.target`) |
| Linux | `.deb` | amd64, arm64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `.rpm` | x86_64, aarch64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `pacman` `.pkg.tar.zst` | x86_64, aarch64 | `electron-builder` or `scripts/package-linux.py` |
| Linux | `tar.gz` | x64, arm64 | `electron-builder` |
| Linux | Snap | amd64, arm64 | `scripts/build-snap.sh` (CI `snap` job) |
| Linux | Flatpak | x86_64, aarch64 | `scripts/build-flatpak.sh` |
| Windows | NSIS `.exe` | x64, arm64 | `electron-builder` on `windows-2022` |
| Windows | portable `.exe` | x64, arm64 | `electron-builder` |
| Windows | `.zip` | x64, arm64 | `electron-builder` |
| macOS | `.dmg` | x64, arm64 | `electron-builder` on `macos-13` / `macos-14` |
| macOS | `.pkg` | x64, arm64 | `electron-builder` |
| macOS | `.zip` | x64, arm64 | `electron-builder` |

Artifacts land in `dist/`. CI uploads them per runner
(`.github/workflows/ci.yml`) and publishes drafts on tags
(`.github/workflows/release.yml`).

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

All Linux packages install the app to `/opt/Commit87`, add `/usr/bin/commit87`,
`/usr/share/applications/commit87.desktop`, hicolor icons from 16 to 1024 px, and the
license. The wrapper is a one-line `exec /opt/Commit87/commit87 "$@"`, which keeps
`argv[0]` and working-directory behaviour predictable for deep links and file-manager
integration.

Dependencies:

- Debian/Ubuntu: `git libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
  libatspi2.0-0 libsecret-1-0`, recommends `git-lfs`
- RPM: `git gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libsecret`
- pacman: `git gtk3 libnotify nss libxss libxtst xdg-utils at-spi2-core libsecret`

### `scripts/package-linux.py`

`electron-builder` shells out to a bundled `fpm` whose Ruby build expects
`libcrypt.so.1`. On distributions that only ship `libcrypt.so.2` (recent Fedora), `fpm`
cannot start, so this script builds the three container formats directly:

- **deb**: `ar` archive with `debian-binary`, `control.tar.xz` (control, md5sums,
  postinst) and `data.tar.xz`
- **rpm**: a generated spec (`AutoReqProv: no`, explicit `Requires:`) built with
  `rpmbuild -bb` and `w9.xzdio` compression
- **pacman**: `.PKGINFO` + `.INSTALL` + a `zstd`-compressed tar

Deterministic timestamps come from `SOURCE_DATE_EPOCH` (default `1762300000`) so repeated
builds of the same inputs produce stable archives.

```bash
npm run pack:dir
python3 scripts/package-linux.py            # deb, rpm, pacman
python3 scripts/package-linux.py deb        # a single format
```

The script prints size and SHA-256 for every artifact.

### Snap

`snap/snapcraft.yaml` is `core24`, strict confinement, `commit87` app, with Git, git-lfs,
OpenSSH and CA certificates staged. The launcher (`snap/local/command.sh`) sets
`GIT_EXEC_PATH`, `PATH`, `GIT_SSL_CAINFO` and starts Electron with `--no-sandbox` (Chromium's
sandbox cannot be used under strict confinement). Plugs include `home`,
`removable-media`, `password-manager-service` and `ssh-keys`.

```bash
npm run dist:snap          # snapcraft pack --destructive-mode
sudo snap install --dangerous commit87_0.1.0_amd64.snap
```

### Flatpak

`flatpak/fr.fradinni.Commit87.yml` uses the `org.freedesktop.Platform` 24.08 runtime with
`org.electronjs.Electron2.BaseApp`, builds Git 2.51.2 from source inside the sandbox, and
installs the unpacked Electron build to `/app/commit87`. Finish args grant `home`,
`removable-media`, wayland/X11, network, DRI, `~/.ssh:ro`, `xdg-run/gnupg:ro` and access to
the Secret Service.

```bash
npm run dist:flatpak
flatpak install --user dist/Commit87-0.1.0-x86_64.flatpak
```

App ID: `fr.fradinni.Commit87`.

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
COMMIT87_STARTUP_TRACE=1 ./dist/Commit87-0.1.0-linux-x86_64.AppImage
# [commit87:startup] main process loaded … +0ms
# [commit87:startup] app ready … +249ms
# [commit87:startup] main window ready … +1290ms
```

## Windows

- NSIS: per-user install, changeable directory, desktop and Start Menu shortcuts,
  uninstall entry, `asInvoker` execution level.
- Portable `.exe`: single self-extracting executable.
- `.zip`: unpacked directory.
- `build/installer.nsh` only adds notices about the Git for Windows requirement.

Code signing uses `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in CI; unsigned local builds
still run but show a SmartScreen warning.

## macOS

- `.dmg` with a `/Applications` symlink and a `.zip` for tooling.
- `hardenedRuntime: true`, entitlements in `build/entitlements.mac.plist` (JIT,
  unsigned executable memory, network client, user-selected files, Apple events).
- Notarization uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- Builds are separate per architecture (`macos-13` x64, `macos-14` arm64) so the arm64
  package is natively built for Apple Silicon rather than cross-compiled.

## Icons

`build/icon.svg` is the single source of truth. `npm run icons` rasterises 16–1024 px PNGs
with ImageMagick, assembles a multi-resolution `icon.ico`, and produces `icon.icns`
(either with `iconutil`/`png2icns` when present, or via `scripts/make-icns.py`, which writes
the ICNS container with PNG chunks for `ic07`–`ic14`).

## Versioning

One version source: `package.json`. `node scripts/sync-version.mjs [version]` rewrites
`src/main/version.ts`, `snap/snapcraft.yaml` and adds the Flatpak metainfo release entry.
The release workflow calls it with the pushed tag.

## Verification performed for this repository

Built and inspected on Fedora 44 x86_64:

| Artifact | Result |
| --- | --- |
| `Commit87-0.1.0-linux-x86_64.AppImage` (94 MB) | builds; app launches |
| `Commit87-0.1.0-linux-x64.tar.gz` (116 MB) | builds |
| `Commit87-0.1.0-amd64.deb` (82 MB) | `ar` members and control fields verified |
| `Commit87-0.1.0-x86_64.rpm` (79 MB) | `rpm -qip` / `rpm -qlp` verified, no duplicate entries |
| `Commit87-0.1.0-x86_64.pkg.tar.zst` (109 MB) | `.PKGINFO` and tree verified |
| `dist/linux-unpacked` | launches and loads the renderer from the ASAR |

Snap, Flatpak, Windows and macOS artifacts require their native toolchains and are
produced by CI; their manifests are validated by schema/consumer tooling rather than by a
local build in this environment.