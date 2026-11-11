# Changelog

All notable changes to Commit87 are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- macOS installs that are not signed with an Apple Developer ID now get real in-place
  updates. `scripts/install-macos.sh` installs a release from the command line without the
  Gatekeeper step (the archive is downloaded with `curl`, verified against the release
  `SHA256SUMS.txt` and its code signature, then installed to `~/Applications`), and the
  in-app updater offers the same verified release-zip swap in Settings → Updates, so ad-hoc
  builds no longer need the releases page. Developer ID-signed builds keep the
  Squirrel.Mac updater and the `latest-mac.yml`/`beta-mac.yml` feed.
- Every macOS release now attaches `install-macos.sh`.

### Fixed

- macOS update preparation now fails before quitting when the installation is not writable,
  restores the previous app correctly after a failed swap, and never replaces a still-running
  app after a shutdown timeout. Download filesystem errors are handled normally, and deferred
  packages use one bounded private cache across restarts. Cleanup handles physical ASAR
  archives correctly in Electron, and stale installation preparation cannot delete or
  overwrite the state of a newer channel's package.
- Ad-hoc macOS builds honor Beta-to-Stable downgrades. The command-line installer supports
  offline uninstall and explicit pinned reinstalls/downgrades; updater tests clean only their
  own isolated fixtures.
- Both macOS updaters choose the highest matching release instead of the first entry in the
  GitHub API's creation-ordered list, so a backport published later cannot hide a newer
  release. `install-macos.sh` now rejects an option without its value, lists `--system` and
  `--keep-work` in `--help`, is covered by `SHA256SUMS.txt`, and removes its temporary feed
  copy when interrupted; the in-app swap helper restores the previous bundle on termination
  signals and no longer hangs if the helper exits before a cancelled handoff.

## [0.2.0-beta.9] — 2026-11-11

### Fixed

- An update check no longer crashes the main process with `write EPIPE` when the app was
  launched with stdout or stderr attached to a pipe whose reader has exited (a closed
  terminal or a launcher that quits). Stdio errors are tolerated and the updater's log sink
  can no longer abort a check.

## [0.2.0-beta.8] — 2026-11-11

### Fixed

- AppImage updates work again when the bundled runtime mounts the image with its file name
  as the kernel mount source instead of the full path; verification no longer depends on the
  directory the AppImage was launched from, and a kernel loop mount is followed to its
  backing file.

### Security

- When the bundled AppImage runtime records only the image file name as the mount source
  (the FUSE shape), the hint is accepted only for a file with that same name. The kernel
  keeps no directory for that mount, so a same-named file in another directory becomes the
  replacement target; the AppImage path itself, not the mounted contents, decides what is
  written.

## [0.2.0-beta.7] — 2026-11-10

Readiness milestone: protect existing work, make the documented boundaries real, and make
setup, release and packaging reproducible. See `docs/remediation-2026-11-10.md` for the
finding-by-finding status.

### Added

- Staging now shows both the staged and the worktree side of a partially staged file, with
  the action scope for each side and a preview that reloads after staging changes.
- Commit messages and conflict resolutions are kept per repository, and conflict drafts per
  file and content baseline, so switching views or tabs no longer discards them.
- Changed-file rows are keyboard-navigable (arrow keys, Home/End, Enter/Space) and their
  actions are visible on focus; dialogs move focus inside, trap Tab, close on Escape only
  for the top-most dialog and restore focus.
- A native picker chooses the Git executable, and repository/worktree access is recorded as
  an explicit grant when the user picks, opens, clones, initialises or creates it.
- Provider lists (pull requests, releases, pipelines) load more pages, and a reloaded window
  restores running and recently finished tasks from a bounded main-process snapshot.
- First-success and recovery guides (`docs/getting-started.md`, `docs/recovery.md`).

### Changed

- One identity precedence in main: explicit pick, repository default, the identity Git
  resolves for that repository (including `includeIf`), then the application default.
  Continue and other continuations no longer commit as the wrong person, and signing
  settings are not forced onto repository-authored work.
- Credentials are authorized per operation destination before a helper is scoped to it;
  provider-name guesses can no longer release a token, and changing an integration endpoint
  invalidates the stored secret.
- Bare clones open with graph, branches, tags and remotes, and worktree-only actions report
  that they need a working tree instead of failing with a Git fatal.
- Fresh dependency installation starts `npm run dev` without a manual Electron install step.
- Releases resolve one validated version and channel for tag and manual runs, verify channel
  metadata, architectures and artifacts before publishing, and keep Windows/macOS grouped.
- Optional Flatpak, Snap and fallback pacman recipes are architecture-aware and covered by a
  static recipe check; support tiers are documented as supported, buildable or experimental.
- Repository discovery is cached for stable facts only; a status poll now spawns about three
  Git processes instead of about fifteen, while branch, status and operation state stay live.

### Fixed

- Selected filenames no longer act as patterns: staging, unstaging and discarding
  `notes[1].txt` leaves `notes1.txt` untouched, and unstaging a staged rename clears both
  sides of it.
- Checking out a ref never falls back to restoring a same-named tracked file, and multiline
  tag messages no longer create phantom tags; a tag and a branch with the same name no
  longer collide.
- Removing a submodule keeps its module clone (moved aside and reported), so unpublished
  commits and stashes stay recoverable, and re-adding the same submodule works.
- Conflict saves are rejected when the file changed since it was loaded, keeping the newer
  bytes and the user's edit.
- In-place updates are bound to the AppImage mount that contains the running executable and
  revalidated before download and install; unpacked, extracted, Snap, Flatpak and loop
  mounted runs fail closed.
- Pull-request checkout fetches and verifies the forge-reported head for every provider, so a
  fork branch named like the destination branch can no longer check out the wrong commit.
- A draft release requested for GitLab is rejected before any write instead of being
  published as an ordinary release; unsupported controls are hidden per provider.
- Merge, rebase, continue, skip, cherry-pick, revert and discard return a machine-readable
  outcome built from the real exit status, so a refusal, hook failure or conflict is never
  announced as success, and a signalled or timed-out Git process keeps its null exit code.
- An interrupted rebase keeps the comment character it chose, so a reword subject starting
  with `#` survives Continue or a restart.
- JSON provider requests send `Content-Type: application/json`; Gitea task runs decode the
  documented envelope; Bitbucket uses correct state queries and continuation links.
- Stale refresh results can no longer overwrite newer data, and console output for a closed
  repository tab never appears in another tab.
- Keyword: repeated full repository discovery, unbounded task output and stale pagination
  no longer grow without bound.

### Security

- File and ref operations execute with literal path semantics and validated operands, and
  the console accepts only a bounded command grammar rather than a spelling deny-list.
- The IPC boundary decodes every payload strictly (real booleans, known enums, validated
  revisions and paths) and pins each handler result to its declared response type.
- Repository roots, linked worktrees and custom Git executables are authorized by
  main-owned grants; file reads resolve the authorized root and never follow symlinks.
- Credential tokens stay in the child environment, scoped to one exact origin, and are bound
  to the authority they were issued for. Tokens saved by earlier versions carry no authority
  and must be entered once more.
- Release jobs run read-only by default, write only in the prepare and publish jobs, do not
  persist checkout credentials, scope signing secrets to their platform and pin actions.

## [0.2.0-beta.6] — 2026-11-09

### Fixed

- macOS builds no longer offer **Restart & install** when the app is ad-hoc signed.
  Squirrel.Mac validates a downloaded update against the running bundle's designated
  requirement, and an ad-hoc signature pins that requirement to the current `cdhash`, so
  every update was rejected with "code is not compliant with specified code requirements".
  The updater now probes the bundle with `codesign`, reports in-place updates as
  unavailable and points at the releases page, while Developer ID-signed builds keep
  automatic updates. Existing ad-hoc installations need one manual DMG update to move onto
  a signed build.

## [0.2.0-beta.5] — 2026-11-09

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
