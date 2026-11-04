# Changelog

All notable changes to GitGrove are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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