# Changelog

All notable changes to Commit87 are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.6] — 2026-11-09

### Added

- Commit graph multi-select: click selects one commit, `Ctrl/Cmd`-click toggles individual
  commits, `Shift`-click selects an inclusive range from the anchor, and `Ctrl/Cmd+Shift`
  adds a range. The arrow keys move or extend the selection, `Ctrl/Cmd+A` selects every
  loaded commit and `Escape` clears it. Selection and anchor are kept per repository tab.
- A right-click context menu for the selection (also opened with the context-menu key or
  `Shift+F10`): copy SHA/subject, open on forge, detached checkout, create a branch or tag
  here, cherry-pick, revert, reset, select all and clear. Single-commit actions are offered
  for one commit; cherry-pick, revert, copy, select-all and clear work on any selection.
  Bulk cherry-pick replays oldest first, bulk revert rewrites newest first, merge commits
  are excluded from both, and a selection summary in the details panel offers the bulk
  actions without right-clicking.
- Conflicts from a cherry-pick or revert are reported as errors while the status bar keeps
  offering Continue, Skip and Abort.

### Fixed

- Commit-graph selection now reconciles correctly when a filter, refresh or history rewrite
  removes commits: surviving commits stay selected, removed commits fall back to the
  nearest selection, and a commit selected from the refs panel remains visible even when it
  is outside the loaded window.
- A removed or rewritten commit no longer leaves a stale selection behind when its details
  cannot be loaded.
- Windows release jobs now run the full test suite; the multi-commit history fixtures no
  longer depend on the platform's `core.autocrlf` setting.
- CI and release packaging retry transient Electron/toolchain download failures with
  backoff and reuse the electron-builder cache, so one network blip no longer fails an
  otherwise healthy release build.

### Maintenance

- Updated Vite from 8.3.5 to 8.3.6.
- Updated lucide-react from 1.68.0 to 1.69.0.

## [0.2.0-beta.4] — 2026-11-09

### Fixed

- macOS builds no longer report "the application is damaged" on Apple Silicon. Patching
  Electron's fuses invalidated the ad-hoc signature on the patched binaries, and without a
  Developer ID certificate electron-builder skipped re-signing, so macOS killed the app at
  launch with `SIGKILL (Code Signature Invalid)`. The bundle is now re-signed ad-hoc right
  after the fuse patch (and Developer ID signed when a certificate is configured), and CI
  verifies the signature of every produced macOS bundle.

## [0.2.0-beta.3] — 2026-11-08

### Fixed

- Recent repositories now survive restarts. Opening a repository writes the profile
  immediately, concurrent profile writes are serialised, a failed write is reported without
  blocking the open, and an unreadable or corrupt `config.json` is kept aside instead of
  being overwritten with defaults.
- Linked worktrees are only added to the recent repositories when the OS opens them as a
  standalone repository (file browser, deep link or second instance). Opening one from its
  parent's worktree list, its tab strip or the command palette no longer adds it or reorders
  the list.
- Task completion is announced after its exit bookkeeping lands, so a freshly cloned
  repository appears in the launchpad without another refresh.

### Added

- Folder launches: `file://` URLs from Linux file managers and macOS `open-file` events
  resolve to the repository. Linux packages advertise `inode/directory` and refresh the
  desktop database on install and removal, and rpm pre-release versions are packaged with
  the prerelease part in `Release`.

## [0.2.0-beta.2] — 2026-11-08

### Added

- Resizable sections in the refs panel: Local grows from the top and the other sections keep
  a stored height against the bottom edge. Drag the splitter above an expanded section (or
  focus it and use the arrow keys; double-click resets) and the size survives collapsing,
  resizing the panel and reopening it. Collapsing Local hands its height to the first
  expanded section below so the stack closes up, sections without rows stay header-only,
  and filtering keeps a single scroll area.

## [0.2.0-beta.1] — 2026-11-06

### Added

- Refs panel in the sidebar (`Navigate` / `Refs`): grouped local and remote branches, linked
  worktrees, stashes and tags with live filtering and keyboard navigation. A single click
  selects a row; double-click or `Enter` switches. A branch checked out in another worktree
  opens that worktree instead of letting Git refuse the checkout, and row menus expose the
  same branch, worktree, tag and stash actions as the full pages. Open it from the sidebar
  toggle, `Ctrl/Cmd+Shift+B`, the command palette or the View menu.
- Worktree status in the refs panel: open/current state, dirty file counts and lock/prunable
  flags, backed by a batch `git.worktreeStatuses` read that reports missing checkouts without
  failing the whole list.
- Default worktree parent in Settings. New worktrees still default to a sibling folder, and
  every worktree dialog accepts a one-off path.
- Repository tab strip: the launchpad button stays reachable, the new-tab menu lists recent
  repositories and worktrees, and a repository and its linked worktrees stay together as one
  drag-and-drop group.

### Fixed

- Launching the production main bundle directly no longer fails at startup when
  electron-updater reports a non-semver app version; updates report unavailable instead.
- The commit graph keeps a tag or remote ref selected as its branch filter instead of
  clearing it on the next refresh.

## [0.1.0] — 2026-11-06

First public release.

### Added

- Repository launchpad: open, clone (HTTPS/SSH, shallow, bare), init, recent list with
  pinning and per-entry removal
- Commit graph with lane layout, refs and tags, search, branch filter, pagination and
  a commit details panel with changed files and inline diffs
- Files & staging: staged/modified/untracked/conflicted groups, per-file stage, unstage,
  discard (with untracked cleanup), commit box with amend, sign-off and identity picker
- Code browser for the working tree and `HEAD`, syntax highlighting, blame and
  open-in-OS-editor
- Branches: local/remote listing with ahead/behind, checkout, create, rename, delete
  (optionally on the remote), set upstream, merge strategies and rebase
- Conflict-aware operation banner with continue, skip and abort for merge, rebase,
  cherry-pick, revert, `git am` and bisect
- Worktrees: list, open in a new window state, create from a branch or new branch,
  lock/unlock with reason, prune and force-remove
- Tags: annotated and lightweight, push, delete locally and remotely
- Stashes: push with untracked files, apply, pop and drop
- Remotes: add/edit/remove, fetch/push URL separation, per-repository remote, identity and
  forge account binding
- Forge integrations for GitHub (incl. Enterprise), GitLab (incl. self-hosted), Bitbucket
  Cloud and Gitea/Forgejo: repository listing, pull/merge requests, creation, local
  checkout, releases, pipelines and workflow dispatch
- Identity management: multiple name/email identities with SSH key and GPG signing,
  default plus per-repository override, per-commit picker
- Git console with a strict allow-list, no shell, output streaming and history
- Command palette with commands, views, branches and recent repositories
- Hardened Electron configuration: sandboxed renderer, custom `commit87://` protocol,
  strict CSP, hardened fuses, ASAR integrity
- Encrypted token storage through the OS credential store with a plaintext fallback that
  is reported in the UI
- Packaging: AppImage, deb, rpm, pacman, tar.gz, Snap and Flatpak for Linux; NSIS,
  portable and zip for Windows x64/arm64; dmg and zip for macOS Intel/Apple Silicon
- Fallback Linux packager for hosts where `fpm` cannot run
- CI for typecheck, tests and per-architecture packaging; tag-driven draft releases
- Auto-updates for the AppImage, NSIS installer and macOS app bundle, with stable and beta
  channels. Settings → Updates shows the installed version, channel, download progress,
  release notes and the last check; a title-bar chip appears when a build is available or
  ready to install. Updates check automatically after launch (configurable, including the
  background download) and install only through **Restart & install**, so quitting never
  swaps the binary silently. Prerelease tags publish `beta.yml` as a GitHub pre-release so
  stable installs never see them. Flatpak, Snap, portable, zip and package-manager builds
  report their own update path instead of being patched in place
- Repository tabs: keep several repositories open at once, each with its own view,
  commit selection, commit-graph filters and git console output. Open or activate from the tab
  strip, the command palette, recent repositories, worktrees, submodules or a deep link;
  drag to reorder, middle-click to close. `Ctrl+Tab` cycles, `Ctrl/Cmd+1…9` jumps and
  `Ctrl/Cmd+W` closes a tab. Streaming fetch/pull/push/console results are routed to the
  repository that started them, so a background tab refreshes itself without disturbing
  the active one
- Submodule management: list initialized, uninitialized, out-of-sync and conflicted
  submodules with their checked-out or recorded commit, URL, tracked branch and local-change flags;
  initialize and update (including to the tracked branch), sync URLs, add with an optional
  branch, remove with an explicit force option, and open the nested repository. Removal is
  staged, cleans the current worktree's module clone, and refuses before touching the
  checkout when `.gitmodules` has unstaged changes
- Interactive rebase planner: pick, reword, squash, fixup, drop and reorder the commits
  between a base and `HEAD` in one dialog. Reword messages survive conflict stops and
  Continue, and the bridge keeps app-controlled editor scripts in the git dir instead of
  opening an external editor
- Conflict resolver: for each conflicted block, keep ours, theirs, both or the base, or
  remove it; the resolved file can be edited manually in the output pane and staged in one
  action

### Fixed

- Files & Staging: a conflicted path now shows its working-tree content with the
  conflict blocks highlighted, instead of an empty diff. Git emits a combined
  diff (`diff --cc`) for unmerged paths, which the unified-diff view cannot parse
- Linux packaging: CI installs `libarchive-tools` (bsdtar) before building, so the
  pacman target no longer fails with `fpm` exit code 127 when generating `.MTREE`
- Linux packaging: the pacman target now writes an xz-compressed
  `Commit87-<version>-linux-<arch>.pkg.tar.xz` instead of an untyped `.pacman` archive,
  and CI uploads it under the matching name
- macOS packaging: build only the `.dmg` installer and the `.zip` the updater consumes;
  the `.pkg` target is no longer produced
- Windows packaging: NSIS and portable targets now build one file per architecture
  (`-win-x64-`/`-win-arm64-`) instead of also emitting an arch-less universal installer
  and portable exe that bundled both payloads
- Release workflow: clears the draft release's assets before a rebuild and serializes
  release runs, so republishing a tag no longer fails with GitHub `422 already_exists`
  while replacing `latest*.yml`

### Changed

- Renamed the application to Commit87: the window, installers, Linux packages,
  Flatpak and Snap manifests, the package id (`fr.fradinni.Commit87`),
  `commit87://` deep links, `COMMIT87_*` environment variables, the preload
  bridge and the executable all use the new name. On first launch the previous
  profile (`config.json`, `secrets.json`) is copied from the old user-data
  directory; tokens encrypted under the old app identity may need to be entered
  again
- Commit graph: compact lane assignment closes merged lanes instead of drawing stray
  lines, and a dedicated Branch / Tag column shows local branches, remotes, tags and
  detached HEAD next to a narrower graph and denser rows
- Cold start: window creation no longer waits for Git identity discovery, a native splash
  covers renderer start-up, the initial bundle no longer loads `highlight.js`, and the
  ASAR excludes bundled production dependencies
- AppImage uses gzip compression instead of xz for faster reads; opt-in startup tracing is
  available through `COMMIT87_STARTUP_TRACE=1`
- macOS Intel x64 builds are published again. Both architectures are packaged on
  `macos-15` (x64 cross-built) because the Intel `macos-13` runner image is retired
