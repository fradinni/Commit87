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
| `tests/parsers.test.ts` | porcelain v2 status (including renames, unmerged, initial/detached), log, branches, tags, remotes, worktrees, stashes, numstat, blame, scoped config |
| `tests/remote.test.ts` | remote URL parsing (scp, `ssh://` with port, nested groups, Bitbucket Server `scm/`), provider detection, account host matching, web/base URL normalisation |
| `tests/credentials.test.ts` | identity environment, SSH command quoting, credential-helper argv safety, secret redaction |
| `tests/ui-logic.test.ts` | unified diff parser (adds/deletes/renames/binary), commit graph lane layout, console tokenizer and allow-list |
| `tests/providers.test.ts` | GitHub, GitLab, Bitbucket and Gitea mapping, auth headers, enterprise base paths, error messages, workflow dispatch payloads |
| `tests/git.integration.test.ts` | real `git` end-to-end: init, status, staged diff, commit with identity, branch create/checkout/merge, annotated tags, worktree add/remove, stash push/apply |

Total: 42 tests. The integration suite creates a temporary repository under
`os.tmpdir()` and removes it afterwards; it requires `git` on `PATH`.

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
- **Provider request shapes**: URL, method, headers and JSON body for dispatch, plus error
  text that includes the HTTP status.

## Manual verification performed

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