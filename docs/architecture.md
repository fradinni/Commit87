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
│  protocol.ts     commit87://app scheme, serving out/renderer                  │
│  store.ts        config.json + secrets.json (safeStorage), repo defaults       │
│  tasks.ts        TaskManager, git console grammar                             │
│  git/            runner (spawn), parsers, repo operations                     │
│  providers/      HTTP clients for GitHub/GitLab/Bitbucket/Gitea               │
│  ipc/            router tables, strict decoders, main-owned grants            │
└──────────────▲───────────────────────────────┬───────────────────────────────┘
               │ ipcRenderer.invoke            │ webContents.send
┌──────────────┴───────────────────────────────▼───────────────────────────────┐
│  Preload (contextBridge → window.commit87)                                   │
│    invoke(channel, payload) · onTaskEvent · onWindowState · onMenu            │
└──────────────▲───────────────────────────────┬───────────────────────────────┘
               │                               │
┌──────────────┴───────────────────────────────▼───────────────────────────────┐
│  Renderer (sandboxed React 19)                                               │
│    zustand store · views · diff/graph parsers · highlight.js                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Why a custom protocol instead of `file://`

Electron disables extra `file://` privileges by default. Serving the renderer from
`commit87://app` lets us keep `grantFileProtocolExtraPrivileges: false` **and**
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
| `tasks.*` | the running/recent task snapshot used to reconcile after a renderer reload |
| `update.*` | update status, check, download and install |
| `window.*` | minimize/maximize/close for the custom title bar |

`Router.handle` dispatches through two exhaustive tables in `src/main/ipc/router.ts`:

- `DECODERS` maps every channel to a strict decoder from `unknown` to that channel's
  declared request type;
- `handlers` maps every channel to a handler whose return type is pinned to
  `IpcResponse<K>`.

Both tables are checked against mapped types, so a missing channel or a handler that
returns the wrong shape fails compilation. The payload is never cast: handlers only see
already-decoded values, and decoders ignore harmless extra fields but reject a field that
is present and wrong. `handle` still exposes the same signature to `index.ts`, with a
typed overload for callers that know the channel.

### Validation and authorization

`src/main/ipc/validate.ts` holds the decoders:

- `str` / `optStr` / `text` reject wrong types, empty required values and NUL bytes;
  `bool` accepts only `true` and `false`, so the string `"false"` never enables
  `force`, `amend`, `includeUntracked`, `staged`, `detach`, `prune`, `rebase` or any other
  flag. Optional flags use a strict `bool(value ?? false)`.
- `num` requires a finite whole number inside an explicit range; `enumOf` rejects an
  unknown member instead of falling back to a default (reset mode, pull-request state,
  update channel, provider).
- `revision` accepts a branch, tag, remote ref, `HEAD~N` or an abbreviated/full object
  name and rejects a leading `-`, whitespace/control characters, `..` and `@{`.
  `revisionRange` validates both sides of `A..B` / `A...B`. `refName` applies Git's
  branch/tag rules, `relPath`/`headPath` require a repository-relative path, and
  `repoPath` requires an absolute path. `hexDigest`, `remoteName`, `slugPart`, `word`,
  `remoteUrl`, `configKey` and `folderName` cover the remaining field shapes.
- Every caller-provided revision or ref is validated before it reaches `argv`: checkout
  targets and start points, branch create/rename/delete, merge, rebase, tag target/name,
  reset, worktree branch/start point, log/diff/commit-detail/blame, upstream, submodule
  branch, and remote name/URL. Where Git supports it, revisions are also passed after
  `--end-of-options`.
- File lists for stage/unstage/discard are re-validated; no path may be empty, contain
  NUL, be absolute, or have `.`/`..` segments. Every file-oriented command also passes them
  after `--` with literal-pathspec semantics, so a name that looks like an option or a
  wildcard stays one file.
- `safeJoin` in `git/repo.ts` resolves repository-relative paths and rejects anything that
  escapes the repository (including `..` and absolute paths).

### Authorization grants

A renderer string is never proof that the user chose a path. `src/main/ipc/grants.ts`
persists `userData/grants.json` (mode `0600`, atomic writes) with:

- canonical `realpath` repository roots;
- linked-worktree aliases, recorded as the shared common Git directory;
- canonical custom Git executables.

Grants are issued only in the main process:

- a folder or file returned by `app.pickDirectory` / `app.pickFile` / `app.pickGitBinary`;
- an OS launch argument or deep link handled in `src/main/index.ts`;
- `repo.clone` (the destination is derived and granted before the task starts) and
  `repo.init` (the target must already be inside a granted folder);
- `git.worktreeAdd` (the target must be inside a granted folder, including a worktree
  parent chosen with the picker, or directly next to the repository) and the created
  worktree;
- `repo.open` of a remembered recent repository (recents are loaded into the grant store
  at startup), or of a repository nested inside a granted root such as a submodule; the
  resolved repository then gets its own exact grant.

Every `repo.*`, `git.*` and file-oriented `provider.*` operation first checks the grant
without spawning Git, then resolves the repository and checks the canonical path/common
Git directory again before any read or write. That second check closes the
pick-then-swap race. An arbitrary `repo.open`, a renderer confirmation flag or an opaque
value minted by the renderer does not create access. `app.openPath` and
`showItemInFolder` are restricted to granted paths and the app profile folder.

A custom Git executable can only be chosen through the native picker; `config.update`
refuses a `gitBinary` field. When it is chosen, the file must be absolute, regular and
executable and `--version` must succeed; before every spawn it must still exist as a
regular executable file. `app.checkGit` accepts an already-granted path (or PATH `git`),
and a configured executable that was not granted is cleared at startup. `COMMIT87_GIT`
remains a deliberate local override for automation and tests; it is read from the
process environment, never from the renderer, and the same per-spawn check applies.

Grant writes are best effort: a read-only or full profile keeps the in-memory grant for
the session and logs the failure instead of blocking `repo.open` or startup. Removing a
repository from the recent list also revokes its grant.

### File reads

`git.fileTree` and `git.fileContent` authorize the repository first, resolve its real
path, and walk every segment with `lstat`. A symlinked file or directory is listed as
`symlink` but never followed, and reads of it are rejected. The final worktree file is
opened with `O_NOFOLLOW` where the platform provides it, and the existing 3 MiB limit and
binary detection still apply. `HEAD` reads validate the revision and reject a path that
contains `:` or a line break.
- Submodule paths must be repository-relative, stay inside the worktree and avoid `.git`
  and `.gitmodules` after normalization (including `./`, trailing slashes and
  filesystem aliases). Removal only accepts a path reported by `git submodule status`,
  refuses local changes or unpushed commits without `force`, refuses an unstaged
  `.gitmodules`, deinitializes and `git rm`s the checkout, restores
  it if the remove is refused, and moves the module clone for the *current* worktree
  (`git rev-parse --git-path modules/<name>`) aside to `<name>.removed-<timestamp>`.
  Nothing is deleted: unpublished commits, other refs and stashes in that clone stay
  recoverable, the path is returned to the renderer so the UI can show it, and re-adding the
  same submodule afterwards works because the live module path is free. Nested submodules are not listed
  individually; recursive "Update all" advances them, and reset cleans every nested
  checkout inside the selected submodule.
- Submodule add resolves the account with an exact host match against the submodule URL
  and scopes the credential helper to that URL origin. Relative URLs use the current
  branch's remote (falling back to `origin`/the repository default), matching Git's own
  resolution. Updates install no credential helper, so app tokens are never offered to an
  arbitrary `.gitmodules` URL; they use the ambient credential helper/SSH agent and the
  repository identity's SSH key.
- Remote names are restricted to `[A-Za-z0-9._/-]+` and may not start with `-` or contain
  `..`.
- Provider base URLs are parsed as URLs before storage.
- The optional default worktree parent must be an absolute path; worktree creation still
  requires the target folder to be granted (the Settings picker grants it) or a direct
  sibling of the repository, keeps it outside the repository, and validates the branch,
  start point and worktree target.

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
commands. `GitError` keeps `argv`, partial `stdout`/`stderr`, the exit code and the signal
for diagnostics. A child that is terminated (timeout, output cap or another signal) keeps a
`null` exit code and its signal instead of being reported as a successful `0`, so a
truncated or killed command can never look like a completed operation.

The interactive rebase planner is the one caller allowed to override those two editor
variables, and only with app-controlled files. Git has no machine-readable todo interface,
so `git/rebase.ts` prepares `todo`, `sequence-editor.sh`, `edit-message.sh`,
`messages/<sha>.txt` and `context.json` under `<git-dir>/commit87/rebase`, then runs
`git rebase --interactive` with deterministic rebase config. The sequence editor copies
the prepared todo and the message editor replaces the message of a native `reword` action.
It identifies the commit from the last line of git's own `rebase-merge/done` file, so a
skipped or emptied commit never invokes the editor and can never rewrite another commit.
The directory survives conflict stops (including an app restart) and is removed by
Continue, Skip, Abort or the next planner run; it never enters the working tree. The
bridge also selects a `core.commentChar` that no supplied message line starts with, so
subjects such as `#123 fix login` are not mistaken for comments. That character is written
to `context.json` and passed back as `-c core.commentChar=…` by Continue and Skip (possibly
in a later process after a restart), because git's message cleanup would otherwise strip a
`#`-prefixed reword subject. A missing or foreign context file is ignored rather than
failing the resume, and the directory is replaced when a new planner run starts while no
rebase is pending. Planner ranges are capped at 500 commits and ranges containing merge
commits are rejected.

### Bare repositories

`resolveRepo` reads `--is-bare-repository` first and, when true, never runs
`--show-toplevel` or `status`. It returns the bare folder as `path`/`root`, the shared Git
directory as `gitDir`/`commonDir`, and empty worktree facts (`upstream: null`,
`ahead`/`behind: 0`) instead of inventing a clean tree. `RepoInfo.isBare` drives the UI:
graph, branches, tags, stashes and remotes keep working, the tab loads and is remembered
after `clone --bare`, and the status poller skips `git.status`. Status, diff, staging,
discard, commit, checkout, merge/rebase and stash operations reject with
`This is a bare repository; … needs a working tree`, and the app shows a bare-repository
banner in place of an operation state, plus an explicit empty state in Files & staging,
rather than a Git fatal or a fabricated clean tree. Commit and commit-range diffs are
object reads and still work. Bare clones are opened as
repositories, not given a separate worktree-style interface.

### Repository discovery and the poll

`resolveRepo` separates facts that belong to the checkout from facts that change without
Git noticing:

| Reused (until invalidated or a directory disappears) | Read on every call |
| --- | --- |
| canonical path, root, git dir, common dir, name, bare flag, linked-worktree flag | branch, HEAD, status, upstream/ahead/behind, remotes, pending operation |

Stable facts are cached by canonical path after two `rev-parse` calls, and are reused only
while the root, canonical root and git dir still exist. The cache is dropped by
`invalidateRepoDiscovery` on init, clone completion, worktree add/remove and branch
rename; a deleted or re-created folder therefore re-discovers itself. Nothing dynamic is
cached: an external `git switch`, commit, merge or `git rebase` is visible on the next
read, which is what the tests assert.

Reads that only need the live dynamic part are also cheaper. `git.status` output already
carries branch, HEAD, upstream and ahead/behind, so a resolve no longer spends two extra
`rev-parse` calls on them, the pending-operation markers cost one `rev-parse --git-path`
call, and concurrent identical reads of the same checkout share one in-flight promise
(two overlapping resolves, or the 5 s poll's `git.status` and `repo.info`) instead of
running the same processes twice.

Measured with a Git wrapper that logs every invocation, on a small local repository
(unpacked, one commit, one remote), counting processes for one call:

| Work | Before | After (cold / cached) |
| --- | --- | --- |
| `resolveRepo` | 14 | 5 / 3 |
| `repo.info` + `git.status` together (one poll) | 15 | 3 / 3 |

`tests/repo-discovery.test.ts` keeps the cached numbers under a bound so a future change
cannot quietly reintroduce full discovery on every refresh.

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
(token, passphrase) and emits `TaskEvent`s over `commit87:task-event`:

```ts
{ taskId, kind: 'clone' | 'fetch' | 'pull' | 'push' | 'console', phase: 'start' | 'output' | 'end' | 'error', repoPath? }
```

`repoPath` identifies the repository the task belongs to. Fetch, pull, push and console
set it to the repository they run in, and a clone sets it to the target folder, so the
renderer can refresh and stream into the right tab even when the user has switched away.

Output is bounded in main, independent of the UI: streamed text stops at
`TASK_TAIL_BYTES` (16 KiB) per task, a line that never ends is flushed in
`TASK_LINE_BYTES` (4 KiB) pieces instead of growing, blank lines are still skipped, and
redaction runs on the way into the console *and* into the retained tail. The first line
of a chunk is emitted as soon as it is complete, so streaming is unchanged.

Main also keeps a bounded inventory: every running task plus the last
`TASK_RECENT_LIMIT` (20) finished ones, each with its redacted tail. `tasks.snapshot`
returns `{ running, recent }` (`TaskSnapshotEntry`); the renderer subscribes to live
events first and then reconciles the snapshot on boot, so a task that finishes during a
renderer reload is reported once — the store deduplicates by `taskId` and only replays a
console tail whose live stream it never saw. Main knows nothing about tabs.

The UI shows progress in the title bar and a persistent task chip in the status bar. On
exit the store refreshes status, branches and, after clones, the recent repository list,
targeting the tab that started the task. Console lines are addressed to the tab that owns
the `repoPath`; output for a repository that no longer has an open tab is dropped rather
than shown in whichever tab is active.

### Git console grammar

`validateConsoleCommand` tokenizes with quote handling and requires the first token to be
`git`. It does not compare whole strings against a spelling denylist. Instead:

- only harmless global flags (`--no-pager`, `--no-replace-objects`,
  `--literal-pathspecs`, `--no-optional-locks`) may appear before the subcommand; every
  other global option is rejected, including `-cX`, `-C/path`, `--config-env=K=V` and
  `--git-dir`/`--work-tree` in attached or separate form;
- each supported subcommand has a table of allowed long and short flags with their value
  arity, a positional count and whether a pathspec is allowed. Attached (`-n20`,
  `-C/path`), `=` (`--pretty=oneline`) and clustered short forms (`-sb`, `-am`) are
  classified token by token;
- nested commands (`remote`, `worktree`, `stash`, `submodule`, `reflog`,
  `maintenance`) accept only their listed verbs: `submodule foreach/add/update`,
  `worktree add`, `reflog expire` and similar forms are not in the table;
- execution-related options (`--exec`, `--exec-path`, `--upload-pack`,
  `--receive-pack`, `--config-env`, `--git-dir`, `--work-tree`, `--namespace`, `--pager`,
  `--editor`) are rejected wherever they appear, in separate or attached form;
- `config` requires a read-only verb (`--get`, `--get-all`, `--get-regexp`, `--list`),
  so a write, `--file`, `--blob` or `--edit` never passes;
- every revision positional is validated with `revision()` and every pathspec is a
  repository-relative path with no `..` or leading `-`.

The normal forms used by the UI and docs keep working: `status --short --branch`,
`log --oneline -n N`, `remote -v`, `worktree list`, `config --get <key>`, `fetch`, `pull`,
`push`, `branch`, `diff`, `show`, `stash list` and the other documented read/write
commands. The command runs with the repository cwd, no shell, and the same environment as
every other Git call.

`git.setConfig` applies a matching policy: `core.hooksPath`, `core.fsmonitor`,
`core.sshCommand`, `core.pager`, `core.editor`, `filter.*`, `diff.*.textconv`,
`merge.*.driver`, `credential.*`, `alias.*`, `include.*`, `protocol.*`,
`submodule.*.update`, `url.*.insteadOf` and similar keys are refused with an explanation;
ordinary keys keep working.

## Identity and authentication

### Identities

An identity is `{ label, name, email, sshKeyPath?, gpgKeyId?, gpgSign?, isDefault }`.
Resolution happens in the main process (`git/identity.ts`) for every operation that can
create or sign a commit, or contact a remote: commit and amend, tag, merge, rebase (plain
and interactive), Continue/Skip, cherry-pick, revert, stash, push/fetch/pull, console,
remote-branch deletion and submodule add/update. The renderer never compensates for a
missing lookup. Order at call time:

1. explicit `identityId` from the call (per-commit picker)
2. `repoDefaults[repository].identityId`
3. the identity Git resolves for this repository: `--local` first, then the effective
   `user.name` / `user.email` (so `includeIf` and global configuration still apply)
4. the identity marked default
5. the first identity

A repository identity wins over the application default because Git itself resolves it:
name/email come from that identity (a missing field is filled from the selected identity),
its SSH key is kept for authentication, and its signing settings are not forced onto the
work. This is what makes Continue in repository B commit as B even when the application
default is A.

`buildIdentityEnv` exports `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, passes
inline `-c user.name` / `-c user.email` (so hooks and subprocesses see the same identity),
sets `user.signingkey` and `commit.gpgsign` when configured, and points
`GIT_SSH_COMMAND` at the identity's key with `IdentitiesOnly=yes`. Those variables are only
installed when an application identity is actually selected.

The renderer sends `repoDefaults[repository].identityId` (the identity the user picked for
that repository) and never `activeIdentity()`, which also falls back to the application
default. Sending the fallback would turn it into an explicit override and make a commit or
an interrupted operation run as the wrong person.

### Forge accounts

An integration is `{ provider, label, username, baseUrl, authority, identityId? }` plus a token
in the secret store. `authority` is derived from the provider and base URL (normalized host,
explicit non-default port, optional `cloneHost`, and a fingerprint) and binds the token to that
server.

Every authenticated operation follows one authorization path before a credential helper is
built:

1. resolve the effective destination — the fetch URL for fetch/pull/clone, the push URL for
   push; the console checks both;
2. reject plain `http` destinations except loopback addresses;
3. match accounts whose authority equals the destination: exact lowercase host equality, the
   same explicit non-default port, plus the documented `api.github.com`↔`github.com` and
   `api.bitbucket.org`↔`bitbucket.org` mappings. API paths (`/api/v3`, `/api/v4`, `/2.0`) do
   not change the host, and ssh remotes receive no forge token;
4. prefer the repository's pinned account for the provider suggested by the hostname, but only
   if it passes the same destination match.

There is no sole-account fallback and no pinned-account shortcut, and provider-name heuristics
never authorize a token. An explicit `accountId` must match the destination or the operation
fails with an actionable error. No match means the operation runs anonymously: public
operations still work, private ones fail because `GIT_TERMINAL_PROMPT=0`.

For HTTPS Git operations the token is injected through an ephemeral credential helper scoped to
the exact destination origin:

```
-c credential.helper=
-c credential.<scheme://host[:port]>.helper=!f() { if test "$1" = get; then printf "username=%s\npassword=%s\n" "$COMMIT87_USERNAME" "$COMMIT87_TOKEN"; fi; }; f
```

There is deliberately no unscoped form. `COMMIT87_USERNAME` / `COMMIT87_TOKEN` travel in the
child environment; tokens never enter `argv`, so they do not appear in `ps`, shell history, task
output or crash dumps. Task output is additionally redacted before leaving the main process.

### Secret storage

`safeStorage.encryptString` (OS keychain / DPAPI / libsecret) is used when available.
Otherwise the token is stored in `secrets.json` with mode `0600`, and Settings shows an
explicit warning. Each token is stored with the authority fingerprint it was issued for
(`version: 2`, `tokens: { <accountId>: { value, fingerprint } }`). On load, each version 2
entry keeps its recorded fingerprint and a token with no account is dropped. Tokens from a
version 1 file are dropped: they carried no authority and could survive endpoint edits, so
re-binding them to today's server would hand a credential to a destination it was never
issued for. The user enters those tokens once more after the upgrade. `getToken` refuses a
token whose fingerprint no longer matches. Changing an integration's provider, base URL
host, port or path, or clone host clears the stored token unless a replacement is supplied;
label, username and identity edits keep it. Config lives in `app.getPath('userData')`:

- Linux: `~/.config/Commit87/{config.json,secrets.json}`
- macOS: `~/Library/Application Support/Commit87/…`
- Windows: `%APPDATA%\Commit87\…`

`recentRepos` in `config.json` follows the repository the user opened. A linked worktree
is only added when the OS launched Commit87 with that folder (file browser, deep link or
second instance); opening one from its parent's worktree list, its tab strip or the
command palette does not add it.

## Providers

Each provider implements `ProviderClient`:

```ts
getCurrentUser()
listRepos(search?)
getPullRequest(owner, repo, number)
listPullRequests(owner, repo, state, page?)   // PagedResult<PullRequest>
createPullRequest(owner, repo, input)
listReleases(owner, repo, page?)              // PagedResult<Release>
createRelease() / deleteRelease()
listWorkflows(owner, repo, page?)             // PagedResult<ActionWorkflow>
listRuns(owner, repo, workflowId?, page?)     // PagedResult<ActionRun>
triggerAction()
readonly capabilities: ProviderCapabilities
```

`providers/http.ts` centralizes authentication, timeouts (30 s, `AbortSignal.timeout`),
error description (401/403/404 hints) and a `Commit87/0.1` user agent. A serialised JSON body
always carries `Content-Type: application/json`; provider `Accept` headers are preserved.
Authentication per provider:

| Provider | Header |
| --- | --- |
| GitHub | `Authorization: Bearer` + `X-GitHub-Api-Version: 2022-11-28` |
| GitLab | `PRIVATE-TOKEN` |
| Gitea | `Authorization: token` |
| Bitbucket | `Basic` when the username looks like an email, else `Bearer` |

Hosting variants are handled: GitHub Enterprise (`/api/v3`), self-hosted GitLab
(`/api/v4`), self-hosted Gitea (`/api/v1`) and Bitbucket Server `scm/` URLs.

Collections return `{ items, hasMore, nextPage?, unsupported? }`. `nextPage` is an opaque
continuation token: GitHub follows the `Link` header's `rel="next"` page, GitLab uses
`X-Next-Page`, Gitea uses `X-Total-Count` (falling back to a full page) and Bitbucket passes
its `next` URL through. Pull request, release and run lists offer **Load more** in the UI;
an empty list, a failed request and a collection the forge does not expose are displayed
differently (`unsupported` covers Gitea Actions and Bitbucket releases).

### Provider capabilities

`PROVIDER_CAPABILITIES` in `src/shared/types.ts` is static per forge and is returned with
`provider.detect` and `provider.connections`:

| Provider | Releases | Draft | Prerelease | Actions inputs | Pagination |
| --- | --- | --- | --- | --- | --- |
| GitHub | yes | yes | yes | yes | pulls, releases, workflows, runs |
| GitLab | yes | no | no | yes | pulls, releases, runs |
| Bitbucket | no | no | no | no | pulls, runs |
| Gitea | yes | yes | yes | yes | pulls, releases, runs |

The renderer hides controls a provider cannot honour. Main enforces the same rules before a
write: `ProviderService.createRelease` rejects a requested draft or prerelease that the forge
cannot represent (GitLab has neither; Bitbucket has no releases), and
`ProviderService.triggerAction` rejects inputs for Bitbucket Pipelines. The adapters repeat
those checks as a second barrier, so an unsupported intent never reaches HTTP.

### Pull request checkout

Checkout asks the forge for the pull request by number (`getPullRequest`); it never searches
a list page. The normalized `PullRequest` carries `headSha` and, where the forge reports it,
`sourceRepo` (`owner/repo`).

| Provider | Fetch | Verification |
| --- | --- | --- |
| GitHub | `+refs/pull/N/head:refs/remotes/<remote>/pr/N` | commit equals `headSha` |
| GitLab | `+refs/merge-requests/N/head:refs/remotes/<remote>/mr/N` | commit equals `headSha` |
| Gitea | `+refs/pull/N/head:refs/commit87/pull/N`, falling back to the contributor repository | commit equals `headSha` |
| Bitbucket | contributor repo from `sourceRepo`, `+refs/heads/<source>:refs/commit87/pull/N` | commit equals `headSha` |

The contributor URL is built on the destination remote's origin and must match the selected
account's authority. After fetching, `git rev-parse` must equal the reported head; on a
mismatch the temporary ref is deleted and nothing is checked out. The local `pr-N` branch is
only created after verification, and an existing branch still aborts the operation before
anything is fetched. Checkout picks a remote whose destination the selected account is
authorized for (an exact owner/repository match first) and never falls back to an unrelated
remote; every fetch uses the same origin-scoped helper as other operations.

### Provider contract details

- **Bitbucket** PR lists send explicit `state` parameters: `OPEN`, the three closed states
  (`MERGED`, `DECLINED`, `SUPERSEDED`) or all four. Repository, PR and pipeline lists follow
  the `next` continuation; pipeline `sha` comes from the target commit.
- **Gitea Actions** decodes the documented `{ workflow_runs, total_count? }` envelope and
  still accepts a bare array or extra fields. A 404 is reported as `unsupported`, so "Actions
  unavailable" is distinct from an empty run list.
- **GitHub / GitLab** map merged and closed pull requests separately (Gitea too), and expose
  completeness metadata instead of presenting the first page as the whole collection.

## UI

- **State**: a single zustand store holding `tabs: RepoTab[]` plus `activeTabId`. Each tab
  owns the repository info, identity/forge defaults, status, collections (commits,
  branches, tags, worktrees, stashes, submodules, pulls), the active commit and the selected
  commit set, commit-graph search/branch filters and git console output. The store mirrors
  the active tab's fields at the top level so views keep plain selectors; every write to a
  mirrored field is copied
  back into the owning tab record first, and switching tabs hydrates the mirror from the
  target record. Global state (config, toasts, sidebar/palette/dialogs) stays outside the
  tab record. Views remount on a tab switch, so component-local dialog state cannot leak
  into another repository.
- **Request ownership**: every repository-scoped refresh captures a token from a
  `RequestScope` (`src/renderer/src/lib/tabs.ts`) holding the tab lifetime and a per-field
  generation. Opening or closing a tab bumps the lifetime, voiding requests started for an
  earlier tab at the same path; within one lifetime the newest request for a field wins,
  and a result is written per field (repo/status, detection, each collection, commits). A
  stale refresh therefore cannot overwrite a newer status poll, and it never clears a
  draft commit-graph filter: the graph keeps draft search/branch controls separate from
  the applied filter, submits on an explicit action, and reloads from page zero when the
  applied criteria change. The 5 s poll only refreshes status and repository facts.
  `PullsView` keys its effects on `repo.path` plus the account/owner/repo/state strings,
  so a refreshed object does not re-request forge data.
- **Repository tabs**: the strip above the sidebar shows the branch and a dirty dot per
  repository, supports drag reorder, middle-click close and `Ctrl+Tab`, `Ctrl/Cmd+1…9`
  and `Ctrl/Cmd+W`. Opening a path that is already open activates its tab instead of
  reloading it; deep links and second instances take the same path. A deliberate tab switch
  cancels a repository that is still loading, so it cannot steal focus when it finishes.
  Closing the last tab returns to the launchpad.
- **Refs panel**: the sidebar can switch between `Navigate` and `Refs`. The refs mode is a
  compact, keyboard-first tree of local branches, remote branches, linked worktrees,
  stashes and tags for the active repository, opened with the sidebar toggle,
  `Ctrl/Cmd+Shift+B`, the command palette or the View menu. The main checkout is represented
  by its branch in Local; only additional worktree folders are listed under Worktrees. A
  single click selects a row; double-click (or `Enter`) performs the row's primary action.
  Selection is the only full-row highlight; the current branch or worktree keeps an accent
  check/badge. A row's primary action switches to the branch or opens the worktree; a branch
  checked out in another worktree opens that worktree instead of letting Git refuse the
  checkout. Right-click or the row menu exposes the existing actions (create worktree,
  merge, rebase, rename, delete, lock, prune, tag push/delete, stash apply/pop/drop) through
  the same validated IPC calls as the full pages. Worktree rows show dirty counts from a
  batch `git.worktreeStatuses` read. The Branches, Worktrees, Stashes and Tags pages remain
  the authoritative management surfaces; the panel links to them. Expanded sections are
  panes rather than one scrolling list: Local grows from the top, the other sections keep a
  stored height against the bottom edge, and each bottom pane is resized by dragging (or
  focusing and using the arrow keys on) the splitter above its header; Local takes the
  remaining height. A section can be collapsed to its header, and a section with no rows
  stays a header even when expanded. When a section below is expanded, collapsing Local
  gives it that height so the panes close up instead of leaving a gap. While filtering,
  the results share a single scroll area.
  New worktrees are created next to the main repository by default, or in the
  `worktreeParent` folder chosen with the picker in Settings, and every dialog still
  accepts a one-off folder chosen with the picker.
- **Views**: launchpad, commit graph, files/staging, branches, worktrees, submodules, tags,
  stashes, remotes, pull requests, releases, pipelines, settings.
- **Interactive rebase**: a modal planner over `onto..HEAD` where commits can be reordered,
  reworded, squashed, fixed up or dropped; it validates the plan in the renderer and again
  in the main process before replaying it.
- **Staging view**: every changed path is listed once per changed side, so a partially staged
  file appears as a staged row (unstage, discard) and a worktree row (stage, discard). Loads
  are bound to repository, file, side and a request generation, so a late response can never
  fill the editor for another file. Commit messages and conflict resolutions persist per
  repository (and per file and content baseline), survive navigation, and are cleared once
  the commit is made or the conflict is staged.
- **Conflict resolver**: unmerged files are split into ours/theirs/base regions. Each block
  can keep a side, keep both, use the base or be removed, while a live editable output pane
  holds the final file. Saving writes the path (never a symlink or a path outside the repo),
  sends the SHA-256 of the bytes it loaded, and is rejected with the bytes preserved when the
  file changed underneath it; the write is then staged through `git.resolveConflict`.
  Non-UTF-8, symlinked and oversized paths are read-only here and must be resolved in an
  external editor.
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
  per lane, 32 px rows, virtualizable if history grows. Click replaces the selection,
  Ctrl/Cmd-click toggles one commit, Shift-click selects an inclusive range from the anchor,
  and the arrow keys move or extend the selection. A right-click on any row selects it when
  it was outside the current selection, then opens the actions for the selection: for one
  commit, copy SHA/subject, open on forge, detached checkout, branch/tag here and reset;
  for any selection, copy all SHAs, cherry-pick, revert, select-all and clear. Cherry-pick
  replays selected commits oldest first and revert newest first; merge commits are disabled
  for both because Git requires a mainline parent. `git.cherryPick` and `git.revert` take a
  validated list of SHAs and return a `GitOperationResult`; a conflict is reported as a
  pause with its unmerged paths and the status bar offers Continue/Skip/Abort.
- **Theme**: dark and light palettes driven by CSS variables; `system` follows
  `prefers-color-scheme`.
- **Accessibility**: native buttons, `aria-label` on icon buttons, focus-visible outlines,
  `role="status"` for toasts, and a listbox of changed-file rows with roving tab focus,
  Arrow/Home/End navigation and Enter/Space selection whose row actions are visible on focus.
  Modals move focus inside, trap Tab/Shift+Tab, close on Escape only for the top-most dialog
  and restore the previous focus.

## Updates

`main/update-support.ts` decides whether the running build can be updated in place:
packaged AppImages, NSIS installs and macOS app bundles qualify; Flatpak, Snap, portable
and zip Windows builds and distro packages are rejected with a message pointing at their
real update path. An NSIS install is recognised by its uninstaller next to the executable,
so an extracted zip build is not offered an installer that would create a second copy.
macOS builds must also carry a Developer ID Application signature, probed with `codesign`
by `main/mac-signing.ts`: Squirrel.Mac validates the downloaded bundle against the running
app's designated requirement, and an ad-hoc signature pins it to the current cdhash, so
every in-place update would be rejected. `main/updates.ts` owns the state machine (`idle`, `checking`, `up-to-date`,
`available`, `downloading`, `ready`, `error`) and talks to an `UpdateAdapter`, which
`main/update-adapter.ts` implements over `electron-updater`. The adapter is bundled into
the main output, so the packaged ASAR still has no `node_modules` tree.

The replacement target is bound to the running installation before any update work:
`main/appimage-binding.ts` accepts an AppImage only when `realpath(process.execPath)` lies
inside a kernel mount recorded in `/proc/self/mountinfo` that is a squashfs mount, or a FUSE
mount the runtime named after the image (`fuse.squashfuse`, `fuse.appimage`,
`fuse.<image name>`). The mount source is compared as a resolved path when the kernel
records an absolute one (a kernel loop mount is followed to the loop device's backing file
in sysfs), compared as a name when the FUSE runtime records only the image's file name, and
refused otherwise: a relative path proves nothing. The name form is the bundled runtime's
shape and is inherently weaker, because the kernel keeps no directory for it: `APPIMAGE`
may name a same-named file in another directory, and that file would be the one replaced.
`APPIMAGE` and `APPDIR` remain untrusted hints: an inherited variable, a path that exists,
an executable bit or an AppImage header prove nothing. Extracted/unpacked runs, Snap and
Flatpak fail closed with an explicit reason. The verified target's device, inode, size,
modification time, mount point, mount source and filesystem are retained; the adapter
receives that object, sets `APPIMAGE` from it immediately before delegating, and the
service revalidates the identity immediately before download and again immediately before
install, refusing to reach the library when anything changed.

Preferences are part of `AppConfig`:

- `updateChannel` is `stable` (electron-updater channel `latest`) or `beta` (`beta`).
  Switching channels clears a stale offer, cancels a download for the previous channel and
  sets `allowDowngrade` when a prerelease build returns to stable.
- `autoUpdateCheck` checks once shortly after launch and downloads a newer build in the
  background. With it off, a manual check stops at `available` and the user chooses
  Download.

electron-updater's own auto-download and install-on-quit are disabled. The service owns the
download so it can be cancelled, and installing always requires the explicit
**Restart & install** action (`quitAndInstall(true, true)`), which keeps NSIS silent.

The renderer only sees sanitized `UpdateStatus` snapshots through `update.*` IPC calls and
the `commit87:update-status` push channel. It cannot choose a feed URL, version or file:
the feed comes from the packaged `app-update.yml` produced by electron-builder's `publish`
configuration. Progress values are clamped, error messages are collapsed to one line and
release notes are truncated before they cross the boundary. `update.install` is only
accepted in the `ready` phase.

Release tags without a prerelease suffix build `latest.yml` and stay drafts until
published. Tags such as `v0.2.0-beta.1` set `COMMIT87_RELEASE_CHANNEL=beta` in the release
workflow, which publishes `beta.yml`, marks the GitHub release as a pre-release (so
`/releases/latest` keeps pointing at the last stable version) and leaves the stable feed
untouched. Only `-beta.N` identifiers are accepted; other prerelease tags fail the
workflow instead of publishing a channel file no client requests.

## Failure handling

- Mutating operations (merge, rebase, interactive rebase, Continue, Skip, cherry-pick,
  revert) return `GitOperationResult { status, output, exitCode, signal, state,
  inProgress, conflictFiles }`, built from the real child exit status plus
  `getOperationState` and the unmerged paths afterwards. A resolved promise is never
  treated as success: exit 0 with an operation still pending is a pause, and a non-zero
  exit with a clean state is a failure. The renderer refreshes the originating repository
  after every outcome and only shows success for `status: 'ok'`; conflicts stay
  actionable through Continue/Skip/Abort.
- Discard returns `DiscardResult`: untracked paths are cleaned with `git clean`, tracked
  paths restored from HEAD, and a failed restore is reported per path instead of being
  swallowed by the untracked cleanup.
- Git errors are converted to human text (`GitError` strips `hint:` noise) and shown as
  toasts; the repository is refreshed afterwards so a partially applied operation is
  visible.
- Repository state (`merging`, `rebasing`, `cherry-picking`, `reverting`, `bisecting`,
  `applying`) is detected from the git dir and surfaced with Continue/Skip/Abort actions.
- Provider failures include status and a remediation hint; a missing token is reported
  before any network call.
- Status polling every 5 s keeps the working tree indicator fresh without re-reading
  history or forge detection; it reuses repository discovery, pauses while a task runs and
  is skipped entirely for a bare repository. After a renderer reload it also reconciles
  `tasks.snapshot`, so a task that finished while no window was listening is reported
  once instead of disappearing.
- Diagnostics are best-effort. A GUI launch can leave stdout and stderr attached to a pipe
  whose reader has exited (a closed terminal, a launcher that quits), so `main/logging.ts`
  handles errors on both stdio streams and the updater logger writes through a guarded
  sink. A closed log pipe no longer surfaces as an uncaught main-process exception from an
  update check.

## Packaging

`electron-builder.config.cjs` declares the targets; `scripts/build-flatpak.sh`,
`scripts/build-snap.sh` and `scripts/package-linux.py` cover the formats that need extra
tooling or lack a working `fpm` on the build host. See
[packaging.md](packaging.md).

## Operational documentation

- [Getting started](getting-started.md) — system Git discovery, identity versus
  authentication, token scopes and repository grants.
- [Recovery](recovery.md) — what discard, submodule removal, interrupted operations,
  updates and the profile/store leave behind, and what has no undo. The failure handling
  above describes the same outcomes in implementation terms.
- [Remediation status](remediation-2026-11-10.md) — how the 2026-11-10 assessment's
  findings map to this design, the evidence for each, and the claims that remain
  unverified on a Linux validation host.