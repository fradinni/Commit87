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
| `tests/repo-store.test.ts` | zustand store with a stubbed preload bridge: open/activate/close tabs, per-tab isolation, failed opens, task completion and console routing by repository |
| `tests/task-events.test.ts` | streaming task events carry the originating `repoPath` for every phase, and omit it for repository-less tasks |
| `tests/credentials.test.ts` | identity environment, SSH command quoting, credential-helper argv safety, secret redaction |
| `tests/ui-logic.test.ts` | unified diff parser (adds/deletes/renames/binary), commit graph lane layout, console tokenizer and allow-list |
| `tests/providers.test.ts` | GitHub, GitLab, Bitbucket and Gitea mapping, auth headers, enterprise base paths, error messages, workflow dispatch payloads |
| `tests/git.integration.test.ts` | real `git` end-to-end: init, status, staged diff, commit with identity, branch create/checkout/merge, annotated tags, worktree add/remove, stash push/apply |
| `tests/submodule.integration.test.ts` | real `git` end-to-end: add, status/config join, dirty detection and forced clean reset (including nested submodules), checkout drift and update, deinit/reinit, tracked-branch update, URL sync, remove (working tree, module dir, `.gitmodules`, config section), uncommitted-add removal and dirty refusal, linked-worktree isolation, orphan gitlinks, unstaged `.gitmodules` refusal and path validation |

Total: 162 tests. The integration suites create temporary repositories under
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
- **Submodule lifecycle**: status flags are joined to normalized `.gitmodules` paths, local
  changes and checkout drift are detected, update restores the recorded commit, `--remote`
  follows the tracked branch, sync copies `.gitmodules` into the module config, and remove
  clears the working tree, the current worktree's module directory and an empty `.gitmodules` while refusing
  any path not reported by `git submodule status` and any unstaged `.gitmodules` edit.
  Removing from a linked worktree leaves the main checkout's module clone untouched.
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

## Manual verification performed

`bash scripts/demo-tabs.sh` seeds throwaway repositories (including a linked worktree and
uncommitted changes) under `/tmp/gitgrove-tabs` for exercising tabs locally.

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