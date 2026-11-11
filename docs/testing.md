# Testing

```bash
npm test                 # all suites
npx vitest run tests/parsers.test.ts
npx vitest run --reporter=verbose
npm run typecheck        # strict TS across main, preload, renderer
```

## Test isolation

Integration fixtures create their own repositories, branches and submodules inside each
case; no case consumes state another case created. Each test file also runs with a
controlled Git environment (`tests/helpers/git-env.ts`, installed through
`vitest.config.ts`): an isolated `HOME`, an empty system config, a global config with a
deterministic `main` default branch and no signing, and `GIT_TERMINAL_PROMPT=0`. A
developer's `user.*`, `includeIf`, hooks, signing keys or `init.defaultBranch` therefore
cannot change a result; tests that deliberately exercise global configuration set and
restore their own values.

To prove every integration case can be selected on its own:

```bash
node scripts/check-test-isolation.mjs
```

It runs each integration file alone and then every case with
`npx vitest run <file> -t "<name>"`, exits non-zero and lists any case that only passed
because an earlier case or ambient configuration supplied its prerequisites. Pass file
paths to check a subset.

## Suites

| File | Coverage |
| --- | --- |
| `tests/parsers.test.ts` | porcelain v2 status (including renames, unmerged, initial/detached), log, branches, tags, remotes, worktrees, stashes, submodule status/config, numstat, blame, scoped config |
| `tests/remote.test.ts` | remote URL parsing (scp, `ssh://` with port, nested groups, Bitbucket Server `scm/`), provider detection, account host matching (including strict credential hosts), web/base URL normalisation |
| `tests/tabs.test.ts` | repository tab close/cycle/reorder semantics, cross-platform path keys, active-tab patch mirroring, and `RequestScope` lifetime/field generation ownership |
| `tests/repo-store.test.ts` | zustand store with a stubbed preload bridge: open/activate/close tabs, per-tab isolation, failed opens, task completion and console routing by repository, newer-wins overlapping refreshes, close/reopen dropping a stale refresh, a newer graph filter surviving a refresh, task snapshot reconciliation, OS/standalone open forwarding, sidebar navigate/refs mode, per-repository commit and per-file conflict drafts, and truthful operation notices |
| `tests/files.test.ts` | file facets for both sides of a partially staged file, modified renames, untracked/conflicted entries, and the request-identity guard that drops a response finishing after a newer request |
| `tests/task-events.test.ts` | streaming task events carry the originating `repoPath` for every phase, omit it for repository-less tasks, wait for exit bookkeeping before announcing completion; bounded output (tail size, newline-free chunks, partial-line flush, redaction) and the capped running/recent snapshot |
| `tests/repo-discovery.test.ts` | real `git`: stable discovery reuse with live branch/status/operation reads (external change, external merge abort), cache invalidation and removal, a counting-wrapper process bound, and in-flight sharing of concurrent resolves |
| `tests/app-store.test.ts` | profile store persistence and recovery: recent repositories survive a restart, writes are serialised, a failed write recovers, default config is not shared between instances, and an unreadable/corrupt profile is kept aside. Integration authorities bind each token to its server, keep it for label/username edits, clear it when the endpoint changes, drop unbound version 1 tokens and refuse a mismatched authority |
| `tests/recent.test.ts` | recents policy: regular checkouts are recorded, linked worktrees only when the OS opened them standalone, and a failed write is logged instead of failing the open |
| `tests/launch.test.ts` | OS launch parsing: plain folder argv, `file://` URLs from the Linux file manager, `commit87://` deep links, and rejection of files, flags, relative paths and the app itself |
| `tests/credentials.test.ts` | identity environment, SSH command quoting, credential-helper argv safety, one exact-origin helper per destination and redaction |
| `tests/credential-destination.test.ts` | credential destination authorization: explicit account versus clone destination, automatic clone anonymity, separate fetch/push checks, pinned-account clearing when a remote host changes, PR checkout remote selection |
| `tests/ui-logic.test.ts` | unified diff parser (adds/deletes/renames/binary), commit graph lane layout, console tokenizer and bounded command grammar |
| `tests/commit-selection.test.ts` | graph selection model: replace/toggle/range, anchor fallback when a commit disappears, loaded-order normalization, and cherry-pick (oldest first) versus revert (newest first) ordering |
| `tests/commit-shas.test.ts` | IPC commit-list validation for cherry-pick/revert: hex-only object names, duplicate collapsing, empty/oversized lists and option-like values |
| `tests/ipc-boundaries.test.ts` | strict decoding (real booleans, enums, revisions, paths), the console's bounded grammar and its bypass matrix, grant issuance/authorization (picks, recents, linked worktrees, clone/init targets, persistence), custom-executable policy, symlink-aware file reads and the config execution-key policy |
| `tests/refs.test.ts` | refs panel helpers: local/remote folder grouping, current-first ordering, worktree lookup (main checkout excluded from linked worktrees), query matching, cross-platform sibling paths and configured worktree parents |
| `tests/updates.test.ts` | update support per packaging format, progress clamping, channel and auto-check preferences, the check → available → download → ready state machine, error sanitization, concurrent checks, install gating and the automatic check timer |
| `tests/providers.test.ts` | GitHub, GitLab, Bitbucket and Gitea mapping, auth headers, enterprise base paths, JSON bodies, pagination and continuation links, error messages, workflow dispatch payloads, release capability rejection; the mocked fetch fails on any unexpected request |
| `tests/provider-checkout.test.ts` | pull-request fetch planning per provider, contributor-repository fallback for Bitbucket/Gitea forks, authoritative head verification, and deletion of a temporary ref on mismatch |
| `tests/build-packages.test.ts` | packaging wrapper: transient network failures retried with backoff, fatal errors and child exit codes passed through, argument forwarding, attempt and delay configuration |
| `tests/dev-bootstrap.test.ts` | Electron runtime provisioning: a complete runtime needs no download, a missing/partial/stale runtime is repaired once, a failed installer reports an actionable error, and `ELECTRON_EXEC_PATH` is honoured |
| `tests/git.integration.test.ts` | real `git` end-to-end: init, status, staged diff, commit with identity, branch create/checkout/merge, annotated tags, worktree add/remove and worktree status snapshots (including a deleted folder reported as unavailable), stash push/apply |
| `tests/history.integration.test.ts` | real `git` multi-commit history actions: cherry-pick replays several commits in order and reverting them newest first restores the tree. Identity precedence in main: explicit, repository default, Git-resolved local/effective identity and application fallback, including SSH/signing handling for a repository identity |
| `tests/rebase.integration.test.ts` | real `git` interactive rebase bridge: plan order, reorder/squash/drop/reword, a conflict stop and continue, a refused hook, `#`-prefixed rewords across a skip, emptied reword safety, non-UTF-8 content and merge-range rejection |
| `tests/rebase-plan.test.ts` | rebase target normalization, todo parsing and plan validation, message limits, comment-character choice and shell quoting |
| `tests/submodule.integration.test.ts` | real `git` end-to-end: add, status/config join, dirty detection and forced clean reset (including nested submodules), checkout drift and update, deinit/reinit, tracked-branch update, URL sync, remove (working tree, module dir, `.gitmodules`, config section), uncommitted-add removal and dirty refusal, linked-worktree isolation, orphan gitlinks, unstaged `.gitmodules` refusal and path validation |

Total: 486 tests in 27 files. The integration suites create temporary repositories
under `os.tmpdir()` and remove them afterwards; they require `git` on `PATH`.

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
- **Refresh ownership and task retention**: two overlapping refreshes apply newest-wins even
  when the older one resolves last, a refresh started before a tab was closed and reopened
  is dropped, a graph filter typed while a refresh is in flight survives it, console output
  for a closed owner never reaches the active tab, and snapshot reconciliation reports a task
  that finished during reconnection exactly once (and stays silent about older history).
  Bounded output is asserted directly: a 50-character line with no newline is emitted in
  bounded pieces, the retained tail keeps the last lines only, a partial last line is
  flushed on close, and redaction applies to the retained tail too.
- **Discovery cache boundaries**: real `git` proves stable facts are reused while branch,
  status and a pending merge are still read live, that a deleted repository cannot be served
  from cache, and that a counting Git wrapper sees a bounded number of processes for a
  cached resolve and a status poll.
- **Submodule lifecycle**: status flags are joined to normalized `.gitmodules` paths, local
  changes and checkout drift are detected, update restores the recorded commit, `--remote`
  follows the tracked branch, sync copies `.gitmodules` into the module config, and remove
  clears the working tree and gitlink plus an empty `.gitmodules` while refusing
  any path not reported by `git submodule status` and any unstaged `.gitmodules` edit.
  The module clone is moved aside to `<name>.removed-<timestamp>` rather than deleted, so
  unpublished commits stay reachable, and re-adding the same submodule at the same path
  works afterwards. Removing from a linked worktree leaves the main checkout's module clone
  untouched and retains that worktree's own clone.
- **Exact Git targets**: selecting `notes[1].txt` leaves `notes1.txt` untouched, a staged
  rename is unstaged and discarded on both sides, a checkout of a missing ref cannot restore
  a tracked file of the same name, a tag still checks out detached when a branch shares its
  name, and a multiline tag message cannot create a phantom tag. Mutating operations report
  a fast-forward refusal and a hook refusal as failures, a conflict as a pause with its
  files, and a failed tracked restore instead of success.
- **Credential destinations**: a clone/fetch/push is authorized against its effective
  destination, an explicit account for another host fails, the sole saved account cannot be
  used for an unrelated host, the helper is scoped to the exact origin, fetch and push get
  separate secret variables, a pinned account is cleared when the remote host changes, and
  a stored token whose authority no longer matches is refused.
- **Pull request heads**: every provider's checkout plan names an authoritative head, and a
  fetched commit that differs from the forge-reported head deletes the temporary ref and
  fails. Release draft/prerelease intent is rejected before any HTTP write where the forge
  cannot represent it, and pagination follows each provider's continuation metadata.
- **File review ownership**: a late file response cannot fill the editor for another file,
  the conflict editor refuses a save against a changed baseline, and a partially staged file
  exposes both review sides.
- **Update ownership**: an AppImage is accepted only when its mount contains the running
  executable and names the hinted image, whether the kernel records the image path, the
  loop device's backing file or only the file name a FUSE runtime supplies; an inherited
  `APPIMAGE` that does not match the mount, an extracted tree and a mount that names
  another image are refused, and the verified target is rechecked after the environment
  changes and before install. A name-only mount is matched by file name, so a same-named
  file in another directory would be the replacement target (pinned by
  *binds a same-named file when the mount records only the image name*).
- **Development bootstrap**: a missing, partial or stale Electron runtime is provisioned
  once, a complete runtime triggers no download, and a failed installer gives an actionable
  error.
- **Diagnostics**: a closed stdio pipe is ignored instead of becoming an uncaught main
  exception, and a failing log sink cannot abort the caller that was logging.
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
`0.3.0-beta.1`, throttled so the download state is visible. Its `prepare` command also
extracts a packaged AppImage and rewrites the copied `app-update.yml`:

```bash
npm run build
node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64 --dir
# or build a real AppImage:
node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64

node scripts/demo-updates.mjs serve          # terminal 2
```

`prepare <AppImage>` rewrites the feed URL inside an *extracted* copy
(`dist/update-demo/squashfs-root`). That tree can no longer drive the update states: the
replacement target is bound to the mount that contains the running executable, so an
extracted `AppRun` started with `APPIMAGE` set is refused by design and only shows the
unsupported state. Use `prepare` only to inspect the packaged `app-update.yml`.

To exercise check, channel, progress and ready, build the AppImage with a generic publish
URL of `http://127.0.0.1:8787/` (override `publish` in the electron-builder configuration),
launch that AppImage itself so its own runtime provides `APPIMAGE`, and open Settings →
Updates. The demo feed serves x64 metadata only (`latest-linux.yml` and `beta-linux.yml`);
use an x64 AppImage.

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

These observations predate the 2026-11-10 readiness branch and record what was driven by
hand, not an automated gate. See
[remediation-2026-11-10.md](remediation-2026-11-10.md#not-verified-on-this-host) for the
behaviour that remains unexercised.

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

- No rendered-DOM or component test harness: renderer logic is covered through the store
  with a stubbed preload bridge and the packaged app was driven manually, but there is no
  automated Electron regression gate for a complete click-to-commit flow.
- The suite runs in CI on Linux, Windows and macOS (`Native tests` jobs), so platform path,
  casing and POSIX-mode assumptions fail before a release. Installers and app launches are
  still not automated, and none was exercised on the Linux validation host for this branch.
- Provider tests use a mocked `fetch` with strict expectations; a nightly job against a
  throwaway repository on each forge would catch live API drift.
- Clone and worktree flows are covered at the Git layer and partly through the store, but
  not end-to-end through IPC.
- Repository discovery was measured on a small local checkout, not a large monorepo.