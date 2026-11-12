# Readiness remediation status — 2026-11-10

This page records what happened to the findings in the [2026-11-10 assessment](assessment-2026-11-10.md).
The assessment stays as the historical record of snapshot `28525c2` (`0.2.0-beta.5`) and is
not rewritten here. Status describes the branch after the readiness work; evidence is a test
case, a command that was run, or an explicit statement that only source/workflow inspection
was possible.

**Legend:** **fixed** — behaviour changed and evidence exists; **partially fixed** — the
defect is closed but a related guarantee or platform remains unexercised; **documented
limitation** — behaviour is unchanged and now stated honestly; **out of scope** — not
attempted on this branch.

## High-priority findings

| Finding | Status | Addressed by | Evidence |
| --- | --- | --- | --- |
| H1 — filenames act as pathspecs and affect other files | **fixed** | `6ae9093 fix(git): make file, ref and submodule targets exact` | `tests/git.integration.test.ts` → *acts only on the literal path when a pattern-like name is selected*; *unstages both sides of a staged rename through the shared action scope*; file validation cases in `tests/ipc-boundaries.test.ts` → *requires absolute repository paths and relative file paths* |
| H2 — ordinary submodule removal destroys recovery data | **fixed** | `6ae9093 fix(git): make file, ref and submodule targets exact` | `tests/submodule.integration.test.ts` → *retains the module clone aside when ordinary removal drops the checkout*; *keeps the object database when a forced removal discards local changes*; *reuses the retained clone when the old module layout is restored*; *keeps the main checkout intact when removing from a linked worktree*. A separate database purge is not offered (open decision below) |
| H3 — a failed ref checkout can restore a file, and multiline tags invent refs | **fixed** | `6ae9093` | `tests/git.integration.test.ts` → *fails a checkout of a missing ref without restoring a same-named file*; *checks out a tag detached even when a branch shares its name*; `tests/parsers.test.ts` multiline/NUL-framed tag cases |
| H4 — stale conflict content can be saved to the wrong file | **fixed** | `5eab20a fix(files): bind the editor to its target and keep review state` | `tests/files.test.ts` → *rejects a response that finishes after a newer request began*; *rejects everything after an explicit invalidation*; `tests/git.integration.test.ts` → *only resolves a conflict against the baseline that was loaded* |
| H5 — credentials are not bound to their destination | **fixed** | `45a88d0 fix(security): authorize credentials against their actual destination` | `tests/credential-destination.test.ts` (clone/fetch/push authorization, hostile lookalike host, PR-checkout remote); `tests/app-store.test.ts` → *drops unbound version 1 tokens…*, *clears the token when the endpoint changes…*, *refuses a stored token whose recorded authority no longer matches*, *authorizes only an exact destination, never a pinned or sole account* |
| H6 — renderer authority exceeds the stated boundary | **fixed** | `93e2c03 fix(ipc): enforce the declared renderer boundary` | `tests/ipc-boundaries.test.ts` → strict decoding, console bypass matrix, grant issuance, custom-executable policy, symlink-aware reads, config execution-key policy. The renderer is still treated as untrusted; the fix makes main own path, executable and credential authority |
| H7 — inherited AppImage variables can identify the wrong update target | **fixed** | `9192252 fix(updates): bind updates to the running installation` | `tests/updates.test.ts` → *accepts an image whose mount source contains the running executable*; *rejects a non-empty APPIMAGE for an unpacked or extracted run*; *passes the verified target even after the environment hint is mutated*; *refuses to install when the verified image changes after download* |
| H8 — fork PR checkout can report success at the wrong commit | **fixed** | `5109bcd fix(providers): verify pull heads and honour release intent` | `tests/provider-checkout.test.ts` → *fetches a fork branch named like the destination branch from the contributor repository*; *fetches and verifies the dedicated GitHub and GitLab pull request refs*; *deletes the temporary ref when the fetched commit differs* |
| H9 — a GitLab draft release becomes an ordinary release request | **fixed** | `5109bcd` | `tests/providers.test.ts` → *rejects unsupported draft and prerelease intent without a request*; *release capability gate*; capability table returned by `provider.detect`/`provider.connections` and enforced again in `ProviderService` before HTTP |

## Medium findings and provider follow-through

| Finding | Status | Addressed by | Evidence |
| --- | --- | --- | --- |
| Mutation results: success announced after a refusal/conflict/hook failure | **fixed** | `30c1952 fix(git): report operation outcomes, identity and rebase context truthfully` | `tests/git.integration.test.ts` → *reports an ff-only refusal as failed, never as success*; *reports a conflict with its files and keeps the state actionable*; *reports a merge refused by a hook as a failure instead of success*; `tests/repo-store.test.ts` → *never announces a conflict or failure as success* |
| Commit attribution and identity precedence, including Continue | **fixed** | `30c1952` | `tests/history.integration.test.ts` → *identity precedence in main* (explicit, repository default, Git-resolved, application); *does not force the application signing settings onto a repository identity*; `tests/repo-store.test.ts` → *sends only a repository identity choice, never the application default* |
| Partially staged files, rename unstaging, drafts lost on navigation | **fixed** | `6ae9093`, `5eab20a` | `tests/files.test.ts` (both sides, modified rename pair, untracked/conflicted facets); `tests/repo-store.test.ts` → *keeps a commit draft per repository across tab switches*; *keys conflict drafts by repository, file and baseline* |
| Keyboard access on changed-file rows and dialog focus | **fixed (implementation, UI not re-walked)** | `5eab20a` | Changed-file rows have roving tab focus, Arrow/Home/End navigation and actions visible on focus; dialogs move focus inside, trap Tab, close Escape only for the top-most dialog and restore focus (`FilesView.tsx`, `ui.tsx`, `views.css`). No automated keyboard test and no recorded real-app walkthrough in this documentation pass — see the not-verified list |
| Async ownership: stale refreshes and closed-owner console output | **fixed** | `0cf7ed7 fix(state): make asynchronous ownership explicit` | `tests/repo-store.test.ts` → *applies the newest overlapping refresh when the older one resolves last*; *drops output for a closed owner instead of giving it to the active tab*; *does not let an in-flight refresh clear a newer graph filter*; `tests/tabs.test.ts` RequestScope cases |
| Unbounded task output, missing snapshot, repeated full discovery | **fixed** | `0cf7ed7` | `tests/task-events.test.ts` → bounded tail, newline-free stream, partial-line flush, redaction, capped snapshot; `tests/repo-store.test.ts` → task snapshot reconciliation; `tests/repo-discovery.test.ts` → cached facts stay live for branch/status/operation and a counting Git wrapper bounds processes |
| Bare clone opened as a broken worktree | **fixed** | `30c1952` | `tests/git.integration.test.ts` → *opens a bare clone without running worktree-only commands*; `tests/repo-store.test.ts` → *opens a bare repository without running git status or inventing a tree* |
| Interrupted reword loses the safe comment character | **fixed** | `30c1952` | `tests/rebase.integration.test.ts` → *keeps a `#`-prefixed reword when a conflicting commit is skipped*; *keeps rewords working across a conflict stop and continue*; `tests/rebase-plan.test.ts` → comment-character selection |
| IPC/code quality: casts, truthy booleans, unchecked settings | **fixed** | `93e2c03` | `tests/ipc-boundaries.test.ts` → *accepts only real booleans*; *rejects unknown enum members instead of defaulting*; *rejects string booleans before any Git operation* |
| JSON transport lacked `Content-Type` | **fixed** | `5109bcd` | `tests/providers.test.ts` → *writes JSON bodies with the right headers and accepts a bodyless success*; *dispatches a workflow with a JSON body* |
| Gitea Actions response envelope mis-parsed | **fixed** | `5109bcd` | `tests/providers.test.ts` → *decodes the workflow_runs envelope, a bare array, extra fields, and a missing Actions API* |
| Collections stop at the first page; wrong PR state for checkout | **fixed** | `5109bcd` | `tests/providers.test.ts` pagination cases (GitHub `Link`, GitLab `X-Next-Page`, Gitea `X-Total-Count`, Bitbucket `next` and explicit states); `tests/provider-checkout.test.ts` reads the PR by number; UI **Load more** exists in the pulls, releases and actions views (manual, not automated) |

## Distribution, release and documentation findings

| Finding | Status | Addressed by | Evidence |
| --- | --- | --- | --- |
| Fresh `npm ci` then `npm run dev` fails with `Electron uninstall` | **fixed** | `444edc7 chore(build): provision the Electron runtime before dev and preview` | `tests/dev-bootstrap.test.ts` → *provisions exactly once when path.txt is missing, as after a fresh install*; *repairs a partial runtime whose executable is missing*; *replaces a runtime left over from another Electron version* |
| Release preparation ignores draft and derives the channel from the branch | **fixed** | `3e887da chore(release): resolve one version and channel, verify before publishing` | One resolver (`scripts/sync-version.mjs --resolve`) feeds every job; the publish job verifies metadata, files and both Linux architectures before applying flags. Validated statically and against a synthetic fixture; no hosted run on this host |
| Optional Flatpak/Snap/pacman recipes reference wrong paths and architectures | **partially fixed** | `9a6b935 chore(packaging): make optional Linux recipes architecture-aware` | `python3 scripts/check-package-recipes.py` — 43 checks passed on this host (recipe inputs, version agreement, architecture mapping, CA paths, pacman archive root). No Flatpak/Snap toolchain was available, so no bundle was built or installed |
| Signing policy and publication order overstate a guarantee | **fixed (policy), not executed** | `3e887da` plus this documentation change | macOS release workflow verifies Developer ID authority, team identifier and a Gatekeeper pass when secrets exist; without them the build is labelled development/unsigned. `SECURITY.md` and [packaging](packaging.md) now separate production signing from the fallback. No signed or notarized build was produced here |
| A fresh beta profile defaults to stable and can offer an older stable build | **documented limitation** | — | `DEFAULT_CONFIG.updateChannel` is `stable`; existing preferences are preserved. Whether a fresh beta install should start on beta remains an open product decision |
| Release jobs had workflow-wide write access and persisted credentials | **fixed** | `3e887da` | Workflow inspection: read-only default, write only in `prepare`/`publish`, `persist-credentials: false`, signing secrets scoped per platform, actions pinned. Not exercised on GitHub Actions here |
| README claimed discard with undo | **fixed** | `5eab20a` | README staging row now says *discard (no app-level undo)* and links to [recovery](recovery.md) |
| SECURITY omitted default update checking/downloading | **fixed** | This documentation change | `SECURITY.md` → *Updates and network activity*: default on, off switch, explicit install, not telemetry |
| Signing wording implied all release builds are signed | **fixed** | This documentation change | `SECURITY.md` → *Release signing*; README install section; [packaging](packaging.md) tiers |
| Packaging claimed Snap/Flatpak CI artifacts | **fixed** | `3e887da`, `9a6b935` | [packaging](packaging.md) support tiers (supported/buildable/experimental) and local-only statement; static recipe check |
| No first-success or recovery guide | **fixed** | This documentation change | New [getting started](getting-started.md) and [recovery](recovery.md), linked from the README |
| CONTRIBUTING lacked independent review and real-app verification | **fixed** | This documentation change | `CONTRIBUTING.md` → *Review and verification*, including packaging/native evidence |
| Submodule test failed when selected alone | **fixed** | `6ae9093` (fixtures rewritten) | `TMPDIR=/tmp/opencode npx vitest run tests/submodule.integration.test.ts -t "reports local changes inside an initialized checkout"` passed on its own |
| No real-Electron critical-flow gate | **out of scope** | — | Not added on this branch; the manual checks in [testing](testing.md) remain the only end-to-end UI evidence |

## Verification used for this status

- `TMPDIR=/tmp/opencode npm test` — **486 tests passed in 27 files** on this branch. The
  suite count may move as tests are added; this is the run used for the table.
- `python3 scripts/check-package-recipes.py` — **43 recipe checks passed**.
- Focused submodule selection above — **1 passed, 17 skipped**, proving the ordering
  dependency is gone.
- Code and workflow inspection for the release, signing, grant and update claims that cannot
  be executed on this host.

Documentation rows marked "this documentation change" are part of the readiness branch; they
do not have a separate code commit because they only correct claims and add the guides.

## Not verified on this host

The validation host is Linux x64. These remained unexercised, so no claim above should be
read as evidence for them:

- Windows and macOS native behaviour (installers, SmartScreen/Gatekeeper, menu, file
  dialogs and window chrome).
- ARM64 packaging and runtime (Linux arm64 AppImage was built in an earlier packaging check
  but not launched; Windows/macOS arm64 was not run at all).
- Real Flatpak and Snap toolchains — no `flatpak-builder`, `snapcraft` or installed bundle.
- Live forge accounts — no GitHub, GitLab, Bitbucket or Gitea API write, PR checkout or
  release was performed; provider evidence is mocked-`fetch` tests and source inspection.
- Real AppImage replacement — installation was never invoked; the target binding and
  revalidation are unit-tested, but no running AppImage was actually swapped.
- Notarization and code signing — no Developer ID, certificate or Apple credentials were
  available; the signing checks are workflow inspection only.
- Large-repository latency and memory — discovery was measured on a small local checkout
  (14→5/3 processes per resolve, 15→3 per poll), not on a monorepo or a long history.
- Automated Electron regression gate — no Playwright/Electron test suite; the packaged app
  was driven manually in earlier validation, not by CI.
- The real-app keyboard/focus walkthrough for the new review flow — the implementation was
  reviewed, but this pass did not drive the window.
- GitHub Actions execution of the release workflow — no hosted run, upload, signature or
  channel publication was observed.

## Product decisions still open

- **Recoverable discard.** The app still has no undo; a trash/undo buffer is a product
  decision, not a missing bug fix. The current behaviour is documented in
  [recovery](recovery.md).
- **Submodule database purge.** Removal keeps the module clone aside. A separate explicit
  purge action (and its retention period) was deliberately not inferred from the force flag.
- **First-run update channel.** A fresh beta install defaults to the stable channel and can
  be offered an older stable build. Whether beta builds should start on beta, while
  preserving existing preferences, is a policy choice.
- **Signing and support tiers.** Which platforms, package formats and provider versions are
  release-qualified, and whether production releases require signing secrets, remains a
  maintainer decision; [packaging](packaging.md) records the current tiers and evidence.
- **LFS versus inline review.** Git LFS status/pull/prune and inline diff review comments
  compete for the next feature slot; both are listed in the
  [roadmap](roadmap-2026-11-10.md) and neither was selected on this branch.
