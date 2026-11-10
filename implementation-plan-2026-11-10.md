# Commit87 implementation plan

**Purpose:** turn the [assessment](docs/assessment-2026-11-10.md) and
[roadmap](docs/roadmap-2026-11-10.md) into work another coding agent can pick up directly.
Based on `28525c26e93f083d244afec854c1e6b1ddf4fefb` (`0.2.0-beta.5`).
**Status:** proposed work; the assessment did not implement these fixes.

## How to use this plan

1. Read `AGENTS.md`, then the selected package below and its assessment findings.
   Locate the named symbols in the current code; paths refer to the audited snapshot.
2. Work on one behavior at a time. Add a meaningful regression case, change the complete
   main/IPC/renderer call path, and verify the observable result. A package can span several
   small changes; it should not become one large rewrite.
3. When changing a shared contract, update `src/shared/types.ts`, `src/shared/ipc.ts`,
   `src/main/ipc/router.ts`, and all callers together. Renderer calls still go through
   `src/renderer/src/lib/ipc.ts`; preload remains a small bridge.
4. Keep system Git, argument-array spawning, the existing Zustand store, main-owned secrets
   and networking, and explicit update installation. Reuse existing mechanisms where possible.
5. Obtain independent review and update the affected user/developer documentation with each
   change. The final section gives the common verification and handoff requirements.

### Starting point and order

- Start with **1** and the conflict-response fix in **2**: they protect existing work.
- **3–6** close the other release-sensitive credential, privilege, update and provider gaps.
  Complete the shared credential contract in **3** before finalizing authenticated checkout in **6**.
- **7–8** make existing workflows and asynchronous state dependable. Do request correctness
  before performance optimization.
- **9** can proceed alongside application fixes; its development-bootstrap correction can be
  taken first if it is needed to run the app. Release promotion depends on the relevant safety fixes.
- **10** is the final acceptance/handoff stage. Its regression coverage should be built during
  the earlier packages, not postponed until the end.

Parallel agents must own separate edits. `src/main/git/repo.ts`, `src/main/ipc/router.ts`,
`src/shared/types.ts`, `src/shared/ipc.ts`, and `src/renderer/src/store.ts` are shared hotspots:
agree on contracts and serialize overlapping changes. Sharing read-only review is fine.

### Establish a fresh baseline

```bash
npm ci
npm exec --no -- install-electron
npm run typecheck
npm test
```

The explicit installer is needed by the audited Electron/electron-vite combination; use the
installed, lockfile-matched tool. Recheck this requirement if those dependencies change.
The audited full suite passed 297 tests, but one submodule test failed when selected alone
because its fixture depended on a previous test. Package 10 addresses that isolation gap.

Use disposable repositories and a separate app profile for UI checks. On Linux, use unique
directories under `/tmp/opencode`, set `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` for the test app, and
clear inherited `APPIMAGE`/`APPDIR` for non-AppImage launches. Isolate test Git configuration;
do not run destructive examples in the project or a user's repository. Existing fixture/demo
scripts are useful, but inspect their cleanup behavior before supplying a directory.

## 1. Make Git targets exact and preserve recovery data

**Covers:** H1, H2, H3; rename handling.

**Start in:** `src/main/git/repo.ts` (`stageFiles`, `unstageFiles`, `discardFiles`,
`checkoutBranch`, `getTags`, `removeSubmodule`), `src/main/git/parsers.ts` (`parseTags`).
Check callers in `src/renderer/src/views/FilesView.tsx`, `src/renderer/src/views/GraphView.tsx`,
`src/renderer/src/views/BranchesView.tsx`, `src/renderer/src/components/RefsPanel.tsx` and
`src/renderer/src/components/CommandPalette.tsx`, plus `CheckoutInput` in `src/shared/types.ts`.
For removal wording, include `src/renderer/src/views/SubmodulesView.tsx` and the error text
inside `removeSubmodule`.

**Change:**
- Apply literal-path semantics to APIs that receive selected filenames, including related
  diff/conflict operations. Git's `--` alone is insufficient. Keep intentional pattern-based
  commands distinct rather than changing every `runGit` call globally.
- Handle both source and destination of a recognized rename for unstage/discard. Use fresh
  status and distinguish renames from copies; blindly expanding every `origPath` is unsafe.
- Replace the switch-to-checkout fallback with explicit branch-switch versus detached-checkout
  intent. Update every caller, including command-palette/ref actions. Invalid refs must fail
  without becoming file operations. Frame tag records so message lines cannot become tags.
- Preserve the submodule object database during ordinary removal, including forced checkout
  removal. Keep dirty-file and `.gitmodules` guards and rollback. A separate database-purge
  feature is a product decision; do not infer it from the existing force flag. Update removal
  dialogs/errors to explain the actual guard conditions, force effects and retained recovery data.

**Prove:** selecting `notes[1].txt` leaves `notes1.txt` untouched; unstage-all leaves no staged
rename deletion; a missing ref named after a dirty file preserves its contents; detached tag
checkout still works; multiline tags create no phantom refs; unpublished submodule commits,
other refs and stashes remain recoverable after removal. Update tests that previously required
database deletion to assert the corrected recovery contract.

**Tests:** `tests/git.integration.test.ts`, `tests/parsers.test.ts`,
`tests/submodule.integration.test.ts`; exercise the affected UI actions.

## 2. Bind file editors to their targets and retain useful drafts

**Covers:** H4; partial staging, draft loss and keyboard review.

**Start in:** `src/renderer/src/views/FilesView.tsx`,
`src/renderer/src/components/ConflictView.tsx`, `src/renderer/src/store.ts`,
`src/renderer/src/lib/tabs.ts`, `src/main/git/parsers.ts` and `src/shared/types.ts`.
For conflict-save baseline validation, include `readFileContent` / `resolveConflict` in
`src/main/git/repo.ts`,
`src/main/ipc/router.ts`, and the `ResolveConflictInput`/`git.resolveConflict` contract.

**Change:**
- First reject obsolete file responses. Content, errors, loading and save eligibility must
  share a repository/file/request identity. Changing selection invalidates the previous request;
  its later completion or `finally` must not alter the new editor. Verify the destination and
  relevant content baseline before writing a conflict resolution.
- Use the existing index/worktree status facts to expose both sides of a partially staged
  path. Selection must include which side is being reviewed. Keep counts, previews and action
  scope consistent, and reload previews after staging or external changes.
- Store commit drafts per repository and conflict drafts per repository/file/baseline in the
  existing store. Preserve them through navigation; deliberately clear completed drafts and
  handle changed baselines. Update tab initialization/mirroring helpers when adding tab fields.
- Make changed-file rows keyboard-selectable and their actions visible on focus. Fix shared
  dialog focus entry, containment, Escape and return behavior in
  `src/renderer/src/components/ui.tsx` and `src/renderer/src/styles/views.css`.

**Prove:** finish A's read after B's read and confirm B cannot display/save A's content; navigate
away and back without losing a draft; review both sides of an `MM` file; mutate staging without
a stale preview; an external edit after loading causes save to reject while preserving the newer
bytes; select a diff and complete a confirmation using only the keyboard.

**Tests:** extend `tests/repo-store.test.ts` and appropriate pure UI tests; add a targeted
component/Electron case where store tests cannot exercise the editor/focus behavior.

## 3. Authorize credential destinations consistently

**Covers:** H5. **Feeds:** package 6's checkout implementation.

**Start in:** `src/main/store.ts` (`resolveAccount`, `saveIntegration`),
`src/main/ipc/router.ts` (clone/network/auth helpers), `src/main/git/runner.ts`
(`buildAuthArgs`), and `src/main/providers/service.ts` / `remote.ts`.

**Change:**
- Define one operation context: repository, selected remote, effective fetch/push destination
  and authorized account. Preserve documented API-host/clone-host mappings, including enterprise
  endpoints. Provider-name heuristics may suggest a forge; they must not authorize a token.
- Remove cross-host sole-account/pinned-account fallback for credential release. Apply the
  same destination rules to automatic and explicitly selected accounts, fetch/push URLs,
  clone, console authentication and PR checkout. Authorize first, then scope the helper.
- Reuse the scoped helper and eliminate the duplicated unscoped implementation in provider
  checkout. Keep tokens out of argv and renderer responses; preserve redaction.
- Bind retained tokens to their authorized provider/endpoint. Changing authentication
  authority must clear or replace credentials; changing a label must not. Enforce the binding
  at authenticated dispatch too, including redirect behavior.

**Prove:** a same-provider-looking hostile hostname gets no saved token; explicit/pinned IDs
cannot bypass matching; fetch and push destinations are checked separately; valid host mappings
still work; endpoint edits do not reuse old credentials. Use dummy tokens and controlled mocks
or local fixtures, not real accounts.

**Tests:** `tests/credentials.test.ts`, `tests/remote.test.ts`, `tests/providers.test.ts`,
`tests/app-store.test.ts`, plus router-boundary coverage where currently missing.

## 4. Make privileged IPC enforce its declared boundary

**Covers:** H6; unchecked payloads and incomplete handler typing.

**Start in:** `src/main/ipc/router.ts`, `src/main/index.ts`, `src/main/tasks.ts`
(`validateConsoleCommand`), `src/main/git/repo.ts`, `src/main/git/runner.ts`,
`src/main/store.ts`, `src/shared/ipc.ts`; Settings/open-folder callers as needed.

**Change:**
- Strictly decode payloads, booleans, enums, nested defaults and refs/revisions. A string
  `"false"` must not enable force. Reject option-shaped operands and validate parsed object IDs
  before using them in Git arguments. Link handler results to their declared IPC response types.
- Replace spelling-based console exclusions with a bounded grammar for supported command
  forms. Cover attached/short/equals options and nested commands. Audit equivalent typed
  operations and `git.setConfig`; a console-only fix leaves execution routes open.
- Establish main-owned authorization for repository roots and custom Git executables. Use
  trusted selection/launch policy, then validate canonical destinations at use time. Protect
  every executable-setting route, including `app.checkGit` and `config.update`.
- Enforce approved roots and link-aware reads in `git.fileTree` / `git.fileContent`; retain
  size/binary limits. Resolve symlinks according to an explicit policy instead of silently
  treating lexical containment as resolved containment.

**Design decision before this package:** document how native picks, remembered repositories,
linked worktrees, clone/init destinations, startup paths and external deep links obtain grants.
An arbitrary `repo.open(path)`, renderer confirmation flag or newly minted handle is not proof
of authorization. Preserve intentionally trusted local Git/config/hooks without allowing
renderer requests to create equivalent new authority unchecked.

**Prove:** invalid input rejects before spawn/read/write; alternate console spellings do not
bypass restrictions; an unapproved executable/root stays inaccessible; valid authorized paths,
linked worktrees and supported commands continue working. Include escaped symlink targets and
malformed metadata IDs. A warning alone does not satisfy these checks.

**Tests:** extend `tests/ui-logic.test.ts`, `tests/commit-shas.test.ts` and Git tests;
add focused router/authorization tests, for example `tests/ipc-boundaries.test.ts` (new).

## 5. Bind updates to the running installation

**Covers:** H7.

**Start in:** `src/main/index.ts`, `src/main/update-support.ts`,
`src/main/updates.ts`, `src/main/update-adapter.ts` and `tests/updates.test.ts`.

**Change:** establish that the executable/resources actually belong to the indicated
AppImage installation, retain that verified replacement target, and revalidate it immediately
before installation. Treat `APPIMAGE`/`APPDIR` as untrusted hints. The adapter must not delegate
to a library reading a different target after validation. A path, filename, owner or file header
alone does not prove that the image is this running installation.

**Prove:** an unpacked build with inherited AppImage variables cannot reach installation;
changing the target after download is rejected; a legitimate supported AppImage still updates;
unsupported formats show their update instructions; ordinary quitting never installs.
Use inert adapters for destructive rejection cases. Real replacement testing needs disposable
previous/next packages, not the demo's placeholder payload.

Keep first-run beta channel policy separate from this safety fix. Preserve saved preferences
and existing explicit-install/channel-cancellation behavior.

## 6. Correct provider checkout, publication and HTTP contracts

**Covers:** H8, H9 and provider contract findings. **Requires:** package 3's destination rules.

**Start in:** `src/main/providers/types.ts`, `service.ts`, `http.ts`, all four adapter files,
`src/shared/types.ts` (`PullRequest` and release inputs), `src/shared/ipc.ts`, and
`src/renderer/src/views/PullsView.tsx`, `ReleasesView.tsx`, `ActionsView.tsx`.

**Change:**
- Retrieve a PR directly by number with its authoritative source repository/head commit.
  For Bitbucket/Gitea, stop fetching a fork's branch from the destination repository. Fetch
  through a supported, authorized route and verify the head before reporting success; preserve
  existing-local-branch protection and GitHub/GitLab dedicated PR/MR refs.
- Define meaningful release capabilities; reject unsupported draft/prerelease intent in main
  and hide/disable matching UI controls. Do this before or alongside fixing JSON transport:
  a successful HTTP request must not expose the currently masked draft-publication defect.
- Set JSON request media type when sending JSON. Decode the supported Gitea task envelope and
  consumed fields against versioned fixtures; tolerate harmless extra fields.
- Carry pagination/completeness through the provider contract and UI. Correct Bitbucket state
  queries and distinguish empty, failed and unsupported results. Checkout must not depend on
  finding a PR in the first list page.

**Prove:** fork/base branches with the same name resolve to the contributor's head; unsupported
drafts send no publication request; correct methods/headers/bodies reach the mocked endpoint;
empty task envelopes render correctly; later-page PRs and closed/all lists remain accessible.

**Tests:** strengthen `tests/providers.test.ts` so unexpected requests fail and fixtures check
method, URL, headers, body and realistic responses, including bodyless success. Update every
adapter when changing `ProviderClient`, or return a clear unsupported result.

## 7. Preserve Git outcomes, identity and operation context

**Covers:** mutation feedback, identity precedence, resumed rebase and bare-clone usability.

**Start in:** `src/main/git/repo.ts` (`mergeBranch`, `rebaseBranch`, continuation,
`resolveRepo`), `src/main/git/rebase.ts`, `runner.ts`, `src/main/ipc/router.ts`,
`src/shared/types.ts` / `ipc.ts`, renderer store, `BranchesView.tsx`, `RefsPanel.tsx`,
`StatusBar.tsx` and `RebasePlanner.tsx` under `src/renderer/src/`.

**Change:**
- Return machine-readable completion/conflict/failure information where plain output currently
  hides failure. Preserve unsuccessful/signal termination in the runner. Update all success
  notifications and refresh the originating repository after partial changes. Keep legitimate
  untracked-only discard working rather than throwing indiscriminately on its restore step.
- Resolve explicit identity override, repository default and application fallback in main.
  Apply the same policy to continuation and SSH-bearing operations; the renderer must not be
  required to compensate for missing repository-default lookup.
- Persist/reinstate the rebase editor's relevant configuration, including the chosen comment
  character, through Continue/Skip and restart. Handle existing sessions deliberately.
- Use the existing bare-repository fact to avoid worktree-only discovery/loading/actions.
  Make bare-clone completion/opening truthful for supported operations; do not fabricate a
  clean working tree or require a new comprehensive bare-repository interface.

**Prove:** ff-only refusal and hook failure never announce success; conflict state remains
actionable; repository identity B does not become app default A on Continue; interrupted
`#`-prefixed reword survives; bare clone opens without an invalid status call.

**Tests:** `tests/git.integration.test.ts`, `tests/history.integration.test.ts`,
`tests/rebase.integration.test.ts`, store/router tests, and real-app operation banners/toasts.

## 8. Make asynchronous ownership explicit, then reduce measured cost

**Covers:** stale graph/refresh results, closed-tab output, task retention and repeated reads.

**Start in:** `src/renderer/src/store.ts`, `src/renderer/src/lib/tabs.ts`,
`src/renderer/src/views/GraphView.tsx`, `PullsView.tsx`, `src/renderer/src/App.tsx`,
`src/main/tasks.ts`, `src/main/git/repo.ts` (`resolveRepo`) and provider detection.
Wire the task snapshot through `src/shared/types.ts`, `src/shared/ipc.ts` and
`src/main/ipc/router.ts`, and reconcile it with the existing events from `src/main/index.ts`.

**Change:**
- Accept results only for the current tab lifetime/request generation and applied query.
  Keep draft filter controls distinct from applied results; reset pagination when criteria
  change. Output for a closed owner never falls back into another tab.
- Extend the existing main task manager with bounded output, including partial lines, and a
  small running/recent-task snapshot for renderer reconnection. Preserve streaming/redaction;
  main does not need to understand tab layout or become a durable job platform.
- Depend on stable repo/account identifiers in effects. Coalesce overlapping reads and separate
  stable discovery from dynamic status so refresh/polling do not repeat full resolution or
  accidentally reload forge data. Measure representative large repositories before introducing
  broader caches or virtualization.

**Prove:** older results cannot replace newer filters; close/reopen and background work stay
isolated; reconnect restores task state even when a task completes during reconnection;
large/newline-free output remains bounded; external Git changes are still reflected.
Record before/after measurements for performance claims.

**Tests:** `tests/repo-store.test.ts`, `tests/tabs.test.ts`, `tests/task-events.test.ts`;
exercise switching/closing tabs and reconnecting during a task in the app.

## 9. Make setup and release outputs reproducible

**Covers:** development bootstrap, channel preparation, packaging and release authority.

**Start in:** `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`electron-builder.config.cjs`, `scripts/sync-version.mjs`, `scripts/build-packages.mts`,
`scripts/build-flatpak.sh`, `scripts/build-snap.sh`, `scripts/package-linux.py`, `flatpak/`, `snap/`.

**Change in bounded slices:**
- Add idempotent runtime provisioning to documented development/preview setup. Test from a
  fresh dependency installation rather than an already-provisioned developer machine.
- Resolve one validated version/channel before release preparation and use it for tag/manual
  runs, metadata and draft/prerelease flags. Honor the draft option, retaining documented
  manual promotion for draft releases. Build and verify artifacts before upload/promotion.
- Preserve grouped Windows/macOS architecture publication where feeds share filenames.
  Define production signing/notarization expectations separately from contributor fallbacks;
  check actual publisher identity/generated update configuration, not just signature validity.
- Fix Flatpak export/bundle branch agreement, Snap project-relative inputs and certificate
  closure, ARM64 staging-directory selection, and fallback pacman's archive root. Verify with
  native consumers before promoting optional formats beyond experimental support.
- Limit write credentials to publication, scope signing secrets to their platform, disable
  unnecessary persisted checkout credentials and pin actions to reviewed SHAs. Record a useful
  source/build/artifact association without introducing an unrelated compliance programme.

**Prove:** clean dev/preview starts; tag and manual runs agree on channel/version; stable clients
never accept prereleases; draft flags are correct; each claimed native format installs/runs
and uses its intended update path. Record unavailable native checks instead of treating a
cross-packaged artifact as runtime validation.

## 10. Complete acceptance, documentation and agent handoff

**Build during earlier packages:** isolate Git fixtures from ambient configuration and test
ordering; add a small actual-Electron critical-flow check using a disposable profile/repository;
run relevant Windows/macOS behavior checks earlier in the existing CI jobs. Reuse the existing
update and tab demos, and verify the advertised minimum/current Git versions where behavior varies.

**Documentation to maintain:** `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`docs/architecture.md`, `docs/testing.md`, `docs/packaging.md` and affected UI copy. Correct
undo, network-default, signing and package-support claims as their packages land. Add concise
first-run authentication and recovery guidance. Keep the dated assessment as historical evidence;
record remediation status separately rather than rewriting what was observed.

**Final verification, after independent review fixes:**

```bash
npm run typecheck
# Run the focused test file(s), including individually selectable regression cases.
npm test
npm run build
```

For UI-affecting work, also run `npm run dev` and exercise the changed normal, empty and error
flows in the real window. For packaging/update work, verify the affected native artifact and
installation boundary. Passing unit tests or compiling a bundle does not substitute for these.

**Handoff for each completed package:** state the behavior fixed, files/contracts changed,
independent review findings addressed, exact tests/UI scenarios exercised, and unresolved
platform/product decisions. Mark only completed packages as done; name blockers and missing
evidence. Leave the next agent one clear next package or remaining acceptance case.

## Product decisions to surface rather than silently choose

- Main-owned trust-grant policy for existing open/launch/settings flows: required before 4.
- Whether to add recoverable discard or a separate submodule database-purge feature: neither
  is required to stop the demonstrated unintended loss.
- Initial update channel for a fresh beta install, preserving existing user preferences.
- Production signing requirements and supported platform/provider/version tiers.
- LFS visibility versus inline review after the bounded readiness work: choose from user demand.
