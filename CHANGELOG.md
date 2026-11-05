# Changelog

All notable changes to GitGrove are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Commit graph: compact lane assignment closes merged lanes instead of drawing stray
  lines, and a dedicated Branch / Tag column shows local branches, remotes, tags and
  detached HEAD next to a narrower graph and denser rows
- Cold start: window creation no longer waits for Git identity discovery, a native splash
  covers renderer start-up, the initial bundle no longer loads `highlight.js`, and the
  ASAR excludes bundled production dependencies
- AppImage uses gzip compression instead of xz for faster reads; opt-in startup tracing is
  available through `GITGROVE_STARTUP_TRACE=1`

## [0.1.0] — 2026-11-04

First public preview.

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
- Hardened Electron configuration: sandboxed renderer, custom `gitgrove://` protocol,
  strict CSP, hardened fuses, ASAR integrity
- Encrypted token storage through the OS credential store with a plaintext fallback that
  is reported in the UI
- Packaging: AppImage, deb, rpm, pacman, tar.gz, Snap and Flatpak for Linux; NSIS,
  portable and zip for Windows x64/arm64; dmg and zip for macOS Intel/Apple Silicon
- Fallback Linux packager for hosts where `fpm` cannot run
- CI for typecheck, tests and per-architecture packaging; tag-driven draft releases