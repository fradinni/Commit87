# Architecture

## Goals

1. **System Git is the only VCS implementation.** No libgit2, no legacy NodeGit, no
   bundled Git in the desktop packages (Flatpak/Snap excepted because their sandboxes
   cannot execute host binaries).
2. **One validated IPC surface.** The renderer holds no credentials and cannot construct
   arbitrary commands.
3. **Streaming by default.** Clone/fetch/pull/push and the console must show progress, not
   freeze the UI behind a spinner.
4. **Per-repository identity.** A single machine can commit as several people, with
   different SSH and GPG keys, without editing global Git config.
5. **Portable packaging.** The same source builds on x64 and arm64 for Linux, Windows and
   macOS from CI, with no per-platform code paths beyond a few `process.platform` guards.

## Processes

```
┌──────────────────────────── Electron main (Node) ────────────────────────────┐
│  window.ts       hardened BrowserWindow + navigation guards                   │
│  protocol.ts     gitgrove://app scheme, serving out/renderer                  │
│  store.ts        config.json + secrets.json (safeStorage), repo defaults       │
│  tasks.ts        TaskManager, git console allow-list                          │
│  git/            runner (spawn), parsers, repo operations                     │
│  providers/      HTTP clients for GitHub/GitLab/Bitbucket/Gitea               │
│  ipc/router.ts   channel table, argument validation, auth resolution          │
└──────────────▲───────────────────────────────┬───────────────────────────────┘
               │ ipcRenderer.invoke            │ webContents.send
┌──────────────┴───────────────────────────────▼───────────────────────────────┐
│  Preload (contextBridge → window.gitgrove)                                   │
│    invoke(channel, payload) · onTaskEvent · onWindowState · onMenu            │
└──────────────▲───────────────────────────────┬───────────────────────────────┘
               │                               │
┌──────────────┴───────────────────────────────▼───────────────────────────────┐
│  Renderer (sandboxed React 19)                                               │
│    zustand store · views · diff/graph parsers · highlight.js                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Why a custom protocol instead of `file://`

Electron 41 disables extra `file://` privileges by default. Serving the renderer from
`gitgrove://app` lets us keep `grantFileProtocolExtraPrivileges: false` **and**
`onlyLoadAppFromAsar: true`, while ES modules, `fetch()` for bundled assets and the strict
CSP all work. The handler:

- resolves every request under `out/renderer` and rejects traversal
- sets an explicit MIME type and `cache-control: no-store`
- falls back to `index.html` only for extension-less paths

## IPC contract

`src/shared/ipc.ts` declares one interface, `IpcMethods`, mapping each channel to its
request and response type. `src/shared/types.ts` holds the domain types. The preload API
is generic over that map, so a typo in a channel name or payload fails type checking.

Channels are grouped:

| Prefix | Responsibility |
| --- | --- |
| `app.*` | info, git detection, dialogs, external links, config folder |
| `config.*`, `identity.*`, `integration.*` | settings, identities, forge accounts |
| `repo.*` | recent list, open/info/clone/init, repo defaults |
| `git.*` | reads (`status`, `log`, `diff`, `blame` …), writes, and streaming tasks |
| `provider.*` | forge APIs and pull request checkout |
| `window.*` | minimize/maximize/close for the custom title bar |

`Router.handle` is a single `switch` over the union. The default branch uses an
exhaustiveness check (`const exhaustive: never = channel`), so adding a channel without
implementing it fails compilation.

### Validation helpers

- `requireString` / `requireNumber` / `requireStringArray` reject empty or wrongly typed
  values before they reach Git.
- `safeJoin` in `git/repo.ts` resolves repository-relative paths and rejects anything that
  escapes the repository (including `..` and absolute paths).
- Branch and tag names are checked for Git's reserved characters and leading dashes.
- File lists for stage/unstage/discard are re-validated; no path may be absolute.
- Submodule paths must be repository-relative, stay inside the worktree and avoid `.git`
  and `.gitmodules` after normalization (including `./`, trailing slashes and
  filesystem aliases). Removal only accepts a path reported by `git submodule status`,
  refuses local changes or unpushed commits without `force`, refuses an unstaged
  `.gitmodules`, deinitializes and `git rm`s the checkout, restores
  it if the remove is refused, then cleans the module directory for the *current*
  worktree (`git rev-parse --git-path modules/<name>`). Nested submodules are not listed
  individually; recursive "Update all" advances them, and reset cleans every nested
  checkout inside the selected submodule.
- Submodule add resolves the account with an exact host match against the submodule URL
  and scopes the credential helper to that URL origin. Relative URLs use the current
  branch's remote (falling back to `origin`/the repository default), matching Git's own
  resolution. Updates install no credential helper, so app tokens are never offered to an
  arbitrary `.gitmodules` URL; they use the ambient credential helper/SSH agent and the
  repository identity's SSH key.
- Remote names are restricted to `[A-Za-z0-9._-]+`.
- Provider base URLs are parsed as URLs before storage.

## Git execution

### Runner

`runGit(args, options)` spawns `git` with:

```
--no-pager -c core.quotepath=false -c color.ui=false
-c advice.detachedHead=false -c core.fsmonitor=false
```

and the environment:

```
GIT_TERMINAL_PROMPT=0   never block waiting for input
GIT_OPTIONAL_LOCKS=0    avoid touching the index for read-only calls
GIT_PAGER=cat
GIT_EDITOR=true         never wait for an interactive editor
GIT_SEQUENCE_EDITOR=true
LC_ALL=C                stable parsing
```

`shell: false` everywhere. A 120 s default timeout and a 64 MiB output cap bound runaway
commands. `GitError` keeps `argv`, `stderr` and the exit code for diagnostics.

The interactive rebase planner is the one caller allowed to override those two editor
variables, and only with app-controlled files. Git has no machine-readable todo interface,
so `git/rebase.ts` prepares `todo`, `sequence-editor.sh`, `edit-message.sh` and
`messages/<sha>.txt` under `<git-dir>/gitgrove/rebase`, then runs
`git rebase --interactive` with deterministic rebase config. The sequence editor copies
the prepared todo and the message editor replaces the message of a native `reword` action.
It identifies the commit from the last line of git's own `rebase-merge/done` file, so a
skipped or emptied commit never invokes the editor and can never rewrite another commit.
The directory survives conflict stops (including an app restart) and is removed by
Continue, Skip, Abort or the next planner run; it never enters the working tree. The
bridge also selects a `core.commentChar` that no supplied message line starts with, so
subjects such as `#123 fix login` are not mistaken for comments. Planner ranges are capped
at 500 commits and ranges containing merge commits are rejected.

### Parsers

Everything user-visible is parsed from stable porcelain formats:

| Data | Command | Notes |
| --- | --- | --- |
| Status | `status --porcelain=v2 --branch -z` | NUL-delimited, handles renames and unmerged entries |
| Log | `log --pretty=format:%H%x1f%P%x1f…%x1e` | record/field separators, no locale text parsing |
| Branches | `for-each-ref` with `%(upstream:track)` | ahead/behind without a second call |
| Tags | `for-each-ref refs/tags` | annotated vs lightweight via `%(objecttype)` |
| Worktrees | `worktree list --porcelain` | lock reasons, prunable, main vs linked |
| Submodules | `submodule status` + `config -f .gitmodules -z` | top-level flags joined to URL/branch by normalized path; local dirtiness from each checkout |
| Stashes | `stash list --format=%gd%x1f…` | `%x1f`, not `%1f`, for real separators |
| Remotes | `remote -v` | fetch and push URLs merged |
| Blame | `blame --line-porcelain` | grouped by commit blocks |
| Config | `config --list --show-scope` | system/global/local scopes |

The renderer parses unified diffs (`lib/diff.ts`) and lays out the commit graph
(`lib/graph.ts`) with compact lane assignment, so the main process only ships text.
Each lane owns a single pending commit; when a branch merges into a lane that is already
open the redundant lane is closed instead of drawing a stray line to the bottom of the
history. Decorations are classified into the dedicated branch/tag column (local branch,
remote, tag and detached `HEAD`). `git.log` omits commit bodies because the graph only
needs subjects; the body is fetched on demand by `git.commitDetail`.

### Streaming tasks

`TaskManager.start(spec)` spawns Git, splits output into lines, redacts every known secret
(token, passphrase) and emits `TaskEvent`s over `gitgrove:task-event`:

```ts
{ taskId, kind: 'clone' | 'fetch' | 'pull' | 'push' | 'console', phase: 'start' | 'output' | 'end' | 'error', repoPath? }
```

`repoPath` identifies the repository the task belongs to. Fetch, pull, push and console
set it to the repository they run in, and a clone sets it to the target folder, so the
renderer can refresh and stream into the right tab even when the user has switched away.

The UI shows progress in the title bar and a persistent task chip in the status bar. On
exit the store refreshes status, branches and, after clones, the recent repository list,
targeting the tab that started the task.

### Git console allow-list

`validateConsoleCommand` tokenizes with quote handling and requires the first token to be
`git`. It then:

- rejects global options (`-c`, `-C`, `--git-dir`, `--work-tree`, `--config-env`)
- requires the subcommand to be in a read/write allow-list of normal Git commands
- only allows **read-only** `git config` verbs (`--get`, `--get-all`, `--list`, …)
- blocks `rebase --exec`, `bisect --exec`, `alias.*` and `submodule foreach`

The command runs with the repository cwd, no shell, and the same environment as every
other Git call.

## Identity and authentication

### Identities

An identity is `{ label, name, email, sshKeyPath?, gpgKeyId?, gpgSign?, isDefault }`.
Resolution order at call time:

1. explicit `identityId` from the call (per-commit picker)
2. `repoDefaults[repository].identityId`
3. the identity marked default
4. the first identity

`buildIdentityEnv` exports `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, passes
inline `-c user.name` / `-c user.email` (so hooks and subprocesses see the same identity),
sets `user.signingkey` and `commit.gpgsign` when configured, and points
`GIT_SSH_COMMAND` at the identity's key with `IdentitiesOnly=yes`.

### Forge accounts

An integration is `{ provider, label, username, baseUrl, identityId? }` plus a token in the
secret store. Account resolution for a repository:

1. `repoDefaults[repository].integrationByProvider[provider]`
2. an account whose API host matches the remote host
3. the only account for that provider, if exactly one exists
4. otherwise no account (the UI asks you to connect one)

For HTTPS Git operations the token is injected through an ephemeral credential helper:

```
-c credential.helper=
-c credential.helper=!f() { if test "$1" = get; then printf "username=%s\npassword=%s\n" "$GITGROVE_USERNAME" "$GITGROVE_TOKEN"; fi; }; f
```

with `GITGROVE_USERNAME` / `GITGROVE_TOKEN` in the child environment. Tokens never enter
`argv`, so they do not appear in `ps`, shell history, task output or crash dumps. Task
output is additionally redacted before leaving the main process.

### Secret storage

`safeStorage.encryptString` (OS keychain / DPAPI / libsecret) is used when available.
Otherwise the token is stored in `secrets.json` with mode `0600`, and Settings shows an
explicit warning. Config lives in `app.getPath('userData')`:

- Linux: `~/.config/GitGrove/{config.json,secrets.json}`
- macOS: `~/Library/Application Support/GitGrove/…`
- Windows: `%APPDATA%\GitGrove\…`

## Providers

Each provider implements `ProviderClient`:

```ts
getCurrentUser()
listRepos(search?)
listPullRequests(owner, repo, state)
createPullRequest(owner, repo, input)
listReleases() / createRelease() / deleteRelease()
listWorkflows() / listRuns() / triggerAction()
```

`providers/http.ts` centralizes authentication, timeouts (30 s, `AbortSignal.timeout`),
error description (401/403/404 hints) and a `GitGrove/0.1` user agent. Authentication per
provider:

| Provider | Header |
| --- | --- |
| GitHub | `Authorization: Bearer` + `X-GitHub-Api-Version: 2022-11-28` |
| GitLab | `PRIVATE-TOKEN` |
| Gitea | `Authorization: token` |
| Bitbucket | `Basic` when the username looks like an email, else `Bearer` |

Hosting variants are handled: GitHub Enterprise (`/api/v3`), self-hosted GitLab
(`/api/v4`), self-hosted Gitea (`/api/v1`) and Bitbucket Server `scm/` URLs.

Pull request checkout fetches the forge ref into a local branch:

| Provider | Refspec |
| --- | --- |
| GitHub | `+refs/pull/N/head:refs/remotes/<remote>/pr/N` |
| GitLab | `+refs/merge-requests/N/head:refs/remotes/<remote>/mr/N` |
| Bitbucket / Gitea | `+refs/heads/<source>:refs/remotes/<remote>/<source>` |

then `git switch -c pr-N <ref>` with the integration token used for the fetch.

## UI

- **State**: a single zustand store holding `tabs: RepoTab[]` plus `activeTabId`. Each tab
  owns the repository info, identity/forge defaults, status, collections (commits,
  branches, tags, worktrees, stashes, submodules, pulls), commit selection, commit-graph
  search/branch filters and git console output. The store mirrors the active tab's fields
  at the top level so views keep plain selectors; every write to a mirrored field is copied
  back into the owning tab record first, and switching tabs hydrates the mirror from the
  target record. Global state (config, toasts, sidebar/palette/dialogs) stays outside the
  tab record. Views remount on a tab switch, so component-local dialog state cannot leak
  into another repository.
- **Repository tabs**: the strip above the sidebar shows the branch and a dirty dot per
  repository, supports drag reorder, middle-click close and `Ctrl+Tab`, `Ctrl/Cmd+1…9`
  and `Ctrl/Cmd+W`. Opening a path that is already open activates its tab instead of
  reloading it; deep links and second instances take the same path. A deliberate tab switch
  cancels a repository that is still loading, so it cannot steal focus when it finishes.
  Closing the last tab returns to the launchpad.
- **Views**: launchpad, commit graph, files/staging, branches, worktrees, submodules, tags,
  stashes, remotes, pull requests, releases, pipelines, settings.
- **Interactive rebase**: a modal planner over `onto..HEAD` where commits can be reordered,
  reworded, squashed, fixed up or dropped; it validates the plan in the renderer and again
  in the main process before replaying it.
- **Conflict resolver**: unmerged files are split into ours/theirs/base regions. Each block
  can keep a side, keep both, use the base or be removed, while a live editable output pane
  holds the final file. Saving writes the path (never a symlink or a path outside the repo)
  and stages it through `git.resolveConflict`. Non-UTF-8, symlinked and oversized paths are
  read-only here and must be resolved in an external editor.
- **Submodules**: cards show the checked-out commit (or the recorded gitlink when
  uninitialized), `.gitmodules` URL, tracked branch and status
  flag (`up to date`, `not initialized`, `out of sync`, `conflict`) plus uncommitted work
  inside the checkout. Update, tracked-branch update, sync, add and remove are explicit
  actions; remove reports that the change is staged, never touches the remote, and refuses
  before modifying anything when `.gitmodules` has unstaged edits. Reset discards tracked
  changes and removes untracked files after confirmation.
- **Diff renderer**: parses unified diffs into files/hunks/lines with old/new line numbers,
  caps rendering at 6 000 lines, and renders untracked files as highlighted code.
- **Graph renderer**: lane assignment with merge/fork edges as SVG cubic curves, one color
  per lane, 36 px rows, virtualizable if history grows.
- **Theme**: dark and light palettes driven by CSS variables; `system` follows
  `prefers-color-scheme`.
- **Accessibility**: native buttons, `aria-label` on icon buttons, focus-visible outlines,
  `role="status"` for toasts, `aria-modal` dialogs closed with Escape.

## Failure handling

- Git errors are converted to human text (`GitError` strips `hint:` noise) and shown as
  toasts; the repository is refreshed afterwards so a partially applied operation is
  visible.
- Repository state (`merging`, `rebasing`, `cherry-picking`, `reverting`, `bisecting`,
  `applying`) is detected from the git dir and surfaced with Continue/Skip/Abort actions.
- Provider failures include status and a remediation hint; a missing token is reported
  before any network call.
- Status polling every 5 s keeps the working tree indicator fresh without re-reading
  history; it pauses while a task runs.

## Packaging

`electron-builder.config.cjs` declares the targets; `scripts/build-flatpak.sh`,
`scripts/build-snap.sh` and `scripts/package-linux.py` cover the formats that need extra
tooling or lack a working `fpm` on the build host. See
[packaging.md](packaging.md).