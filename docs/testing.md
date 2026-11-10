# Testing

```bash
npm test                 # all suites
npx vitest run tests/parsers.test.ts
npx vitest run --reporter=verbose
npm run typecheck        # strict TS across main, preload, renderer
```

## Suites

| File | Coverage |
| --- | --- |
| `tests/parsers.test.ts` | porcelain v2 status (including renames, unmerged, initial/detached), log, branches, tags, remotes, worktrees, stashes, submodule status/config, numstat, blame, scoped config |
| `tests/remote.test.ts` | remote URL parsing (scp, `ssh://` with port, nested groups, Bitbucket Server `scm/`), provider detection, account host matching (including strict credential hosts), web/base URL normalisation |
| `tests/tabs.test.ts` | repository tab close/cycle/reorder semantics, cross-platform path keys, and active-tab patch mirroring |
| `tests/repo-store.test.ts` | zustand store with a stubbed preload bridge: open/activate/close tabs, per-tab isolation, failed opens, task completion and console routing by repository, OS/standalone open forwarding, sidebar navigate/refs mode |
| `tests/task-events.test.ts` | streaming task events carry the originating `repoPath` for every phase, omit it for repository-less tasks, and wait for exit bookkeeping before announcing completion |
| `tests/app-store.test.ts` | profile store persistence and recovery: recent repositories survive a restart, writes are serialised, a failed write recovers, default config is not shared between instances, and an unreadable/corrupt profile is kept aside |
| `tests/recent.test.ts` | recents policy: regular checkouts are recorded, linked worktrees only when the OS opened them standalone, and a failed write is logged instead of failing the open |
| `tests/launch.test.ts` | OS launch parsing: plain folder argv, `file://` URLs from the Linux file manager, `commit87://` deep links, and rejection of files, flags, relative paths and the app itself |
| `tests/credentials.test.ts` | identity environment, SSH command quoting, credential-helper argv safety, secret redaction |
| `tests/ui-logic.test.ts` | unified diff parser (adds/deletes/renames/binary), commit graph lane layout, console tokenizer and allow-list |
| `tests/commit-selection.test.ts` | graph selection model: replace/toggle/range, anchor fallback when a commit disappears, loaded-order normalization, and cherry-pick (oldest first) versus revert (newest first) ordering |
| `tests/commit-shas.test.ts` | IPC commit-list validation for cherry-pick/revert: hex-only object names, duplicate collapsing, empty/oversized lists and option-like values |
| `tests/refs.test.ts` | refs panel helpers: local/remote folder grouping, current-first ordering, worktree lookup (main checkout excluded from linked worktrees), query matching, cross-platform sibling paths and configured worktree parents |
| `tests/updates.test.ts` | update support per packaging format, progress clamping, channel and auto-check preferences, the check → available → download → ready state machine, error sanitization, concurrent checks, install gating and the automatic check timer |
| `tests/providers.test.ts` | GitHub, GitLab, Bitbucket and Gitea mapping, auth headers, enterprise base paths, error messages, workflow dispatch payloads |
| `tests/build-packages.test.ts` | packaging wrapper: transient network failures retried with backoff, fatal errors and child exit codes passed through, argument forwarding, attempt and delay configuration |
| `tests/git.integration.test.ts` | real `git` end-to-end: init, status, staged diff, commit with identity, branch create/checkout/merge, annotated tags, worktree add/remove and worktree status snapshots (including a deleted folder reported as unavailable), stash push/apply |
| `tests/history.integration.test.ts` | real `git` multi-commit history actions: cherry-pick replays several commits in order and reverting them newest first restores the tree |
| `tests/submodule.integration.test.ts` | real `git` end-to-end: add, status/config join, dirty detection and forced clean reset (including nested submodules), checkout drift and update, deinit/reinit, tracked-branch update, URL sync, remove (working tree, module dir, `.gitmodules`, config section), uncommitted-add removal and dirty refusal, linked-worktree isolation, orphan gitlinks, unstaged `.gitmodules` refusal and path validation |

Total: 297 tests. The integration suites create temporary repositories under
`os.tmpdir()` and remove them afterwards; they require `git` on `PATH`.

## What is asserted, not just executed

- **Parser correctness on edge cases** rather than only happy paths: detached HEAD,
  initial commit, unmerged entries, renamed paths with a following NUL token, binary
  numstat, `locked` worktrees with reasons, tag types.
- **Identity propagation**: commits created through `commitChanges` carry the selected
  name/email, proving `GIT_AUTHOR_*` and inline `-c user.*` work together.
- **Credential hygiene**: the token is absent from the built argv and present only in the
  child environment; redaction removes it from output.
- **Console safety**: `git -c …`, alias definitions, `--exec`, `submodule foreach` and
  non-git commands are rejected.
- **Commit selection**: a plain click replaces the selection, Ctrl/Cmd toggles one commit
  and keeps the active row unless the toggled commit was the active one, Shift selects an
  inclusive range that keeps its anchor across repeated clicks, and a removed anchor falls
  back to the active commit. Reconciliation keeps a commit selected from elsewhere, drops
  rows that were loaded and then disappeared, and clears a selection whose active commit is
  gone. Multi-commit cherry-pick is replayed oldest first while revert walks newest first,
  proven by a real temporary repository.
- **Submodule lifecycle**: status flags are joined to normalized `.gitmodules` paths, local
  changes and checkout drift are detected, update restores the recorded commit, `--remote`
  follows the tracked branch, sync copies `.gitmodules` into the module config, and remove
  clears the working tree and gitlink plus an empty `.gitmodules` while refusing
  any path not reported by `git submodule status` and any unstaged `.gitmodules` edit.
  The module clone is moved aside to `<name>.removed-<timestamp>` rather than deleted, so
  unpublished commits stay reachable, and re-adding the same submodule at the same path
  works afterwards. Removing from a linked worktree leaves the main checkout's module clone
  untouched and retains that worktree's own clone.
- **Provider request shapes**: URL, method, headers and JSON body for dispatch, plus error
  text that includes the HTTP status.
- **Repository tabs**: the renderer store is exercised with a stubbed preload bridge:
  opening the same path twice focuses one tab, concurrent opens collapse to one tab,
  per-tab view and commit-graph filters survive switching, `updateTab` never touches the
  active tab's mirror, a slow open cannot steal focus after a manual tab switch, a failed
  open leaves the loaded repository active, closing the last tab returns to the launchpad,
  a task event for a background repository refreshes only that repository, a refresh
  started for one repository lands there after switching away, a saved commit-graph
  filter is passed to `git log`, a filter that no longer matches still applies the rest of
  the refresh and falls back to all commits, and two concurrent tasks keep the status chip
  until their own end event. A git integration test proves a symlinked path resolves to
  the same `canonicalPath` as the real checkout.
  The tab strip was also driven in the packaged build over CDP: three repositories opened
  as tabs through the single-instance deep link, view memory survived switching, the
  window title followed the active repository, `Ctrl+Tab`/`Ctrl+1` switched and closing
  an inactive tab left the active one untouched.

## Update demo harness

`scripts/demo-updates.mjs` serves a local feed with a stable `0.2.0` and a beta
`0.3.0-beta.1`, throttled so the download state is visible. It also prepares a packaged
AppImage by extracting it and rewriting only its generated `app-update.yml`:

```bash
npm run build
node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64 --dir
# or build a real AppImage:
node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64

node scripts/demo-updates.mjs prepare dist/Commit87-0.1.0-linux-x86_64.AppImage
node scripts/demo-updates.mjs serve          # terminal 2
```

Run the **AppImage itself**, not the tree `prepare` unpacks. The update path is bound to
the mount that contains the running executable, so an extracted `squashfs-root/AppRun`
started with `APPIMAGE` set is now refused by design and only shows the unsupported state.
To exercise check, channel, progress and ready states, build an AppImage whose bundled
`app-update.yml` points at `http://127.0.0.1:8787/` (generic publish URL), launch it as an
AppImage so its own runtime provides `APPIMAGE`, and open Settings → Updates. The feed
metadata is x64-only (`latest-linux.yml`); use an x64 AppImage.

Open Settings → Updates. The flow to check:

1. Stable channel: Check now → 0.2.0 available → Download → progress → ready to install.
   The title bar shows the same state.
2. Switch to Beta and check again: 0.3.0-beta.1 is offered, proving the channel file is
   used; switching back clears the stale offer and cancels a download in flight.
3. Toggle automatic checks off and on; with it on, the next launch checks after about
   12 seconds and downloads in the background.
4. Unsupported builds are covered in the unit tests and visible in the dev app: Settings →
   Updates reports "In-place updates are not available for this build" and links to the
   release page.

Do not press Restart & install with the placeholder artifact: it is not a valid AppImage.
The demo is for the check, channel, progress, ready and error states only.

## Manual verification performed

`bash scripts/demo-tabs.sh` seeds throwaway repositories (including a linked worktree and
uncommitted changes) under `/tmp/commit87-tabs` for exercising tabs locally.

The production build (`out/`), the unpacked package (`dist/linux-unpacked`) and the
AppImage were launched on Linux/Wayland and driven through the Chrome DevTools protocol:

- Launchpad renders, git version and architecture are detected, identity is discovered
  from global git config.
- Opening a real repository loads the commit graph, refs and tags; selecting a commit
  loads details and the changed-file list.
- Staging view shows staged/modified/untracked counts; selecting a file renders the diff
  with line numbers.
- Worktrees view lists the main checkout and a linked worktree with HEAD shas.
- Branches, tags and stashes views render real data from the demo repository.
- Command palette opens with Ctrl/Cmd+K and lists commands, views and branches.
- Git console runs `git status --short --branch` and streams the output.
- Settings shows the system git version and path.

## Gaps and next steps

- No renderer component tests yet; the UI is verified through the packaged app.
- macOS and Windows packages are built in CI and smoke-tested manually per release.
- Provider tests use a mocked `fetch`; a nightly job against a throwaway repository on
  each forge would catch API drift.
- Worktree and clone flows are covered at the git layer but not end-to-end through IPC.