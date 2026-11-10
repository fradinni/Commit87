# Commit87 project assessment

- **Date:** 10 November 2026
- **Snapshot:** `28525c26e93f083d244afec854c1e6b1ddf4fefb` — `0.2.0-beta.5`
- **Assessment branch:** `audit/project-assessment-2026-11-10`
- **Companion:** [High-level roadmap](roadmap-2026-11-10.md)
- **Implementation handoff:** [Work packages and acceptance checks](../implementation-plan-2026-11-10.md)

## Executive assessment

Commit87 has a sound foundation: system Git, a small Electron bridge, main-process
networking and secret storage, useful repository/worktree workflows, and substantial
behavioral tests. The production build and Linux x64 unpacked build/launch were verified.

**The next milestone should protect existing work and make the advertised boundaries
reliable.** Green automated checks currently coexist with reproducible unintended file
changes and loss of unpublished submodule history. Credential destination selection and
update-target ownership also need correction before broader release confidence is justified.

A framework, Git-engine, or state-library rewrite is not supported by the evidence.
Concentrated changes to operation contracts, authorization, request ownership, and release
verification offer a better return. Feature priorities should be reconsidered after a
finite readiness milestone, using actual user demand.

## Scope and independent challenge

Eight independent initial reviews covered:

| Aspect | Main conclusion |
| --- | --- |
| Code quality and architecture | Preserve the process split; consolidate repeated policy and make asynchronous ownership explicit. |
| Git implementation | Filename/ref semantics and submodule cleanup contain demonstrated data-loss paths. |
| Security | Provider identification is being confused with credential authorization; renderer capabilities exceed the documented boundary. |
| Provider integrations | Some successful-looking operations can select the wrong commit or ignore requested publication semantics. |
| User/developer documentation | Detailed reference material exists, but recovery, networking, signing and setup claims drift. |
| Distribution | Linux x64 unpacked build/launch verified; update ownership, channel preparation and optional recipes need attention. |
| UX, accessibility and performance | Core workflows need durable drafts, accurate staging views and keyboard completion; measure scaling before redesigning it. |
| Testing and assurance | Strong lower-layer tests leave gaps between renderer, IPC, Git and native packaging. |

Six fresh-context reviewers challenged the findings and strategic recommendations across
security, Git/UX, architecture/state, providers, documentation, and distribution. The lead
reviewer reconciled disagreements, inspected source, and performed the checks below.
A final independent factual review found no required corrections; its scope-clarification
suggestions were incorporated.

**Evidence labels:** **Reproduced** means observed in isolated local execution; **Source**
means a traced implementation defect or risk without end-to-end reproduction;
**Contract** adds a published API/package contract; **Gap** means missing assurance, not
proof of a failing feature. High/medium describe impact and priority, not a CVSS score.
No finding is presented as an independently demonstrated remote Critical exploit.

## Verification performed

Environment: Linux x64; Node `24.21.0`, npm `11.19.0`, Git `2.56.0`, Electron `45.2.3`.
The starting worktree was clean. Application source and dependency manifests were not edited.

| Check | Result |
| --- | --- |
| `npm ci --no-fund --no-audit` | Passed; development runtime provisioning still required the separate step described below. |
| `npm run typecheck` | Passed for main/preload and renderer. |
| `TMPDIR=/tmp/opencode npm test` | **297 tests passed in 21 suites.** |
| Focused submodule test selection | **Failed in isolation**: `reports local changes inside an initialized checkout` encounters `ENOENT` because an earlier test creates the required checkout. The full-suite result above remains valid. |
| `npm run build` | Passed for main, preload and renderer bundles. |
| `npm audit --package-lock-only --ignore-scripts --json` | **Zero known advisories reported** at review time; this does not assess first-party authorization defects. |
| `node scripts/build-packages.mts --config electron-builder.config.cjs --linux --x64 --dir --publish never` | Passed. The unpacked executable launched. |
| Packaged fuse/ASAR inspection | RunAsNode, Node options, CLI inspect and extra file-protocol privileges disabled; ASAR-only loading and integrity enabled. The app ASAR contained bundled output, without a `node_modules` tree. |
| Fresh `npm run dev` | Failed with `Electron uninstall`; passed after `npm exec --no -- install-electron`. No tracked setup fix was applied. |
| Real Electron UI, driven over CDP | Exercised packaged startup/settings and development-mode repository flows with a separate profile and disposable repositories. |

### Actual UI coverage

- Launchpad and first-run empty state; Settings and detected system Git.
- Opening a repository through the normal second-instance path; commit graph and file diff.
- Per-file staging and ordinary unstaging, corroborated with Git's index.
- Two-sided `MM` status: the remaining unstaged diff/count was missing from the staging view.
- Commit-message draft: navigating to the graph and back erased the draft.
- Empty repository history and a failed non-repository open; the previous tab stayed active.
- `Ctrl+Tab` restored the correct view/console; opening a linked worktree created its tab.
- `Ctrl+K` command palette; `Ctrl+J` console; streamed `git status` and rejected unknown command.
- Unpacked-build update guidance after clearing inherited AppImage environment variables.

Screenshots of the launchpad and staging result were inspected. This was a smoke check,
not an automated UI regression suite or a complete accessibility assessment.

### Additional isolated checks

Actual exported Git operations were loaded and run against temporary repositories with
controlled Git configuration. The fixtures confirmed:

| Scenario | Observed result |
| --- | --- |
| Stage/discard only `notes[1].txt`, alongside `notes1.txt` | Both files were staged; discard also restored the unselected file. |
| Remove a clean submodule containing an unpublished commit recorded in the parent gitlink, with force off | Removal succeeded and deleted the only module object database containing that commit. |
| Check out a nonexistent ref named `README.md` | The dirty tracked file was restored from the index. |
| Annotated tag with a multiline message containing `README.md` | Tag enumeration produced a phantom `README.md` entry with an empty SHA. |
| Unstage the destination of a staged rename | The original path's deletion remained staged. |
| Resolve a bare clone | Failed with “this operation must be run in a work tree.” |
| Request a fast-forward-only merge of diverged branches | The function returned normally with fatal Git output and no machine-readable failure status. |

Validation-only console probes also confirmed that rejected separated options have accepted
attached/alternate forms. No execution-enabled command returned by those probes was run.

## High-priority findings

### H1. Selected filenames can affect other files — High, reproduced

File APIs pass filenames to Git as ordinary pathspecs. `--` ends option parsing but does
not make a path literal. A bracketed filename can match itself and a second filename;
discard therefore changes more than the confirmation identifies.

**Outcome needed:** literal filename semantics throughout file-oriented operations,
including review and conflict staging, with explicit scope for renames.

Evidence: [stage/unstage/discard](../src/main/git/repo.ts#L709-L731),
[file validation](../src/main/git/repo.ts#L1034-L1055).

### H2. Ordinary submodule removal destroys recovery data — High, reproduced

The force-off guard checks checkout dirtiness and gitlink mismatch, not the existence of
unpublished objects. A clean submodule whose new commit is recorded by the parent passes
the guard. The subsequent module-directory deletion removes native Git's retained recovery
database. Other local refs and stashes are also outside the guard's guarantee.

The removal dialog discloses local-clone deletion, but its force wording incorrectly
suggests unpublished history is protected. This requires an explicit removal action;
it is not unattended repository-wide deletion.

**Outcome needed:** preserve the module object database during ordinary removal; make any
purge a separately defined destructive operation. An ahead/behind check alone is insufficient.

Evidence: [guard and deletion](../src/main/git/repo.ts#L400-L461),
[dialog](../src/renderer/src/views/SubmodulesView.tsx#L369-L377).

### H3. Reference checkout can become file restoration — High, reproduced

Any failed `git switch` falls back to overloaded `git checkout <name>`. If the ref is absent
and the name matches a tracked file, checkout restores that file from the index. Multiline
tag parsing independently creates phantom tags from message lines, providing a normal UI
route to such a target through the refs panel.

**Outcome needed:** preserve explicit branch-switch versus detached-ref intent and validate
tag records. Simply deleting the fallback would break legitimate detached-checkout callers.

Evidence: [checkout](../src/main/git/repo.ts#L745-L759),
[tag formatting](../src/main/git/repo.ts#L237-L241),
[tag parsing](../src/main/git/parsers.ts#L225-L251),
[refs-panel checkout](../src/renderer/src/components/RefsPanel.tsx#L590-L595).

### H4. Stale conflict content can be saved to the wrong file — High, source

FilesView does not reject obsolete file-read responses. Select conflicted A, then B; a late
A response can populate the editor while the selected destination is B. Saving then writes
A-derived text into B. Main verifies that B is conflicted, not that this content belongs to B.

**Outcome needed:** bind editable content, loading/error state and saves to repository,
file and request identity; invalidate obsolete responses and changed baselines.

Evidence: [loading](../src/renderer/src/views/FilesView.tsx#L75-L103),
[editor inputs](../src/renderer/src/views/FilesView.tsx#L493-L500),
[save](../src/renderer/src/components/ConflictView.tsx#L73-L77).

### H5. Stored credentials are not bound to authorized destinations — High, source

An ordinary Automatic clone can choose the sole saved account after an exact-host match
fails. A hostname heuristically classified as GitLab can consequently receive a real
GitLab account's token if its HTTPS server challenges for authentication. Renderer compromise
and successful cloning are not prerequisites. The UI describes Automatic as host matching.

PR checkout also combines remote selection and an unscoped credential helper. Separately,
an attacker controlling renderer requests can change an integration's endpoint, retain its
old token, and invoke Test to send that token to the new endpoint.

**Outcome needed:** authorize the account against the actual operation destination before
scoping the helper; bind stored secrets to their approved authentication authority. Preserve
defined API-host/clone-host mappings. Scoping a wrongly selected token to the wrong URL is
not a fix.

Evidence: [account fallback](../src/main/store.ts#L410-L434),
[clone](../src/main/ipc/router.ts#L821-L851),
[helpers](../src/main/git/runner.ts#L218-L245),
[checkout helper](../src/main/providers/service.ts#L142-L194),
[retained secret](../src/main/store.ts#L294-L313).

### H6. Renderer authority exceeds the stated security model — High, source/validator checks

These are distinct paths through the privileged boundary:

- Console checks reject selected spellings, but accept attached configuration options,
  rebase's alternate execution options and option-prefixed submodule iteration. Git can
  execute commands even when its parent uses `shell: false`.
- Typed revision fields can occupy option positions. Rebase execution has repository/upstream
  prerequisites; log/show output options can write Git-generated output to writable paths.
- Custom-Git testing/configuration accepts executable paths, and Git-config mutation permits
  execution-related settings. Custom Git and trusted user hooks are intentional capabilities;
  renderer-provided strings alone do not establish user authorization.
- File-tree/content APIs accept caller-selected roots and follow symlinks. Lexical traversal
  validation does not authorize a root or confine the resolved target. Reads have size/text
  limits; this is not unrestricted binary-file extraction.

Most of these paths assume compromised renderer code or equivalent request control;
**no initial renderer-compromise mechanism or remote exfiltration chain was demonstrated**.
Normal browsing of a repository symlink can also show outside text without renderer compromise.

**Outcome needed:** consistent operand/boolean/config validation plus main-owned authorization
of executable, repository and credential destinations. Granting an opaque handle for any
caller-supplied path would preserve the problem. Console hardening must include equivalent
typed/configuration routes and preserve explicitly trusted local Git behavior.

Evidence: [console](../src/main/tasks.ts#L207-L243),
[typed rebase](../src/main/ipc/router.ts#L430-L435),
[log operands](../src/main/git/repo.ts#L177-L208),
[Git executable](../src/main/git/runner.ts#L248-L267),
[config mutation](../src/main/git/repo.ts#L704-L706),
[file IPC](../src/main/ipc/router.ts#L309-L334),
[file reads](../src/main/git/repo.ts#L640-L677).

### H7. Inherited AppImage variables can identify the wrong update target — High, mixed evidence

A packaged Linux application is classified as an AppImage solely from a nonempty `APPIMAGE`.
In the first isolated packaged launch, inherited launcher variables caused the unpacked app
to download an update and reach **Restart & install**. With those variables cleared, the same
build correctly reported that in-place updates were unavailable.

The locked updater's `AppImageUpdater.doInstall` deletes/replaces the environment-selected
path, without proving it belongs to this running app. The destructive consequence is
source-traced only: **installation was not invoked**. It additionally requires the explicit
install action and suitable filesystem permissions. Normal quitting does not install.

**Outcome needed:** establish ownership between the running package and its replacement
target, bind that target, and validate it again before installation. File existence or an
AppImage header alone cannot establish ownership.

Evidence: [environment forwarding](../src/main/index.ts#L195-L206),
[eligibility](../src/main/update-support.ts#L38-L55),
[installation gate](../src/main/updates.ts#L312-L329);
locked `electron-updater@6.8.11`, `out/AppImageUpdater.js:72-98`.

### H8. Fork PR checkout can report success at the wrong commit — High, source

Bitbucket/Gitea checkout fetches the PR's source branch name from the destination remote.
If a fork's branch is named `main` and the destination also has `main`, checkout can succeed
without the contributor's changes. Source repository and authoritative head SHA are absent
from the normalized model. GitHub/GitLab's dedicated PR/MR refs avoid this particular defect.

**Outcome needed:** resolve the authoritative PR head and destination, fetch through a
supported mechanism, and verify the resulting commit before reporting success.

Evidence: [checkout](../src/main/providers/service.ts#L138-L182),
[PR model](../src/shared/types.ts#L422-L437).

### H9. A requested GitLab draft release becomes an ordinary publication request — High, source/contract

The UI accepts Draft, but the GitLab adapter drops that intent. If the request succeeds,
the resulting release is visible according to project permissions; this does not necessarily
mean public Internet disclosure. Existing HTTP problems may mask the defect but cannot serve
as an intent safeguard. The generic prerelease option is also not faithfully represented.

**Outcome needed:** model meaningful provider capabilities and reject unsupported publication
semantics in main before sending a write; align the UI with those capabilities.

Evidence: [controls](../src/renderer/src/views/ReleasesView.tsx#L231-L237),
[adapter](../src/main/providers/gitlab.ts#L169-L188),
[GitLab release contract](https://docs.gitlab.com/api/releases/#create-a-release).

## Existing-flow correctness and maintainability

These are mostly medium-priority defects or assurance gaps, with incorrect commit attribution
and false mutation success deserving early attention alongside the findings above.

| Area | Finding and appropriate outcome | Evidence |
| --- | --- | --- |
| Mutation results and identity | Merge/rebase and several continuation paths discard failure status; UI callers can announce success. Merge continuation itself throws on failure, but omits the repository identity and can use the app default instead. Centralize documented identity precedence and machine-readable success/conflict/failure outcomes. Preserve legitimate partial Git states. | [operations](../src/main/git/repo.ts#L805-L821), [continue](../src/main/git/repo.ts#L884-L913), [caller](../src/renderer/src/components/StatusBar.tsx#L15-L28), [resolver](../src/main/ipc/router.ts#L1044-L1058) |
| Staging and authoring | Reproduced: partially staged files expose only the staged diff/count; unstaging a rename destination leaves its source deletion staged; commit drafts disappear on view navigation. Keep both index/worktree facets and operation-specific rename scope; retain repository/file-scoped drafts. Stage remaining already exists, and Git still commits the actual index. | [status classification](../src/main/git/parsers.ts#L93-L129), [selection](../src/renderer/src/views/FilesView.tsx#L91-L116), [unstage all](../src/renderer/src/views/FilesView.tsx#L338-L339), [view lifetime](../src/renderer/src/App.tsx#L382-L394) |
| Keyboard access | Changed-file rows are not keyboard-selectable; row actions remain transparent without pointer hover. Shared dialogs have no common focus containment/restoration. Existing shortcuts and some child autofocus work. Complete central review/confirmation flows rather than claim accessibility from ARIA attributes alone. | [rows](../src/renderer/src/views/FilesView.tsx#L388-L421), [styles](../src/renderer/src/styles/views.css#L1034-L1041), [modal](../src/renderer/src/components/ui.tsx#L89-L132) |
| Async ownership | Output for a closed task-owner tab falls into the active tab; old refreshes can overwrite newer query results. Graph controls and pagination can refer to different result sets. Explicit search submission is valid; mixing applied and pending criteria is not. Add request/lifetime acceptance rules at existing scoped-update seams. | [console routing](../src/renderer/src/store.ts#L781-L800), [refresh](../src/renderer/src/store.ts#L562-L604), [graph requests](../src/renderer/src/views/GraphView.tsx#L152-L190) |
| Task and read costs | Streaming retains unbounded output/partial lines and lacks a reconnect snapshot. Full repository discovery is repeated within refresh/polling; refreshed object identity can also retrigger PR loads. These are source-established costs, not measured freezes or a demonstrated completed-task leak. Bound retention, share in-flight/query-specific reads, and profile before broader caching or virtualization. | [tasks](../src/main/tasks.ts#L23-L120), [discovery](../src/main/git/repo.ts#L63-L169), [polling](../src/renderer/src/App.tsx#L219-L232), [PR effect](../src/renderer/src/views/PullsView.tsx#L36-L58) |
| Capability and continuation | Bare clone data is created but opening it fails on worktree-only status. Interrupted reword sessions do not restore the safe comment character, potentially stripping a later `#` subject under normal cleanup. Model bare capabilities and persist the relevant rebase context. The latter was source-reviewed, not reproduced here on the minimum Git version. | [discovery](../src/main/git/repo.ts#L74-L102), [opening](../src/renderer/src/store.ts#L422-L430), [rebase context](../src/main/git/rebase.ts#L94-L145) |
| IPC/code quality | Exhaustive dispatch does not tie every handler return to its declared method type. Destructive booleans use truthiness, and nested settings have unchecked casts. No concrete response-type mismatch was demonstrated. Strengthen method-linked typing and runtime decoding, and extract duplicated policy rather than splitting files merely by size. | [dispatcher](../src/main/ipc/router.ts#L47-L48), [defaults](../src/main/ipc/router.ts#L224-L234), [force](../src/main/ipc/router.ts#L545-L550) |

### Provider contract follow-through

- **JSON transport:** serialized JSON lacks `Content-Type: application/json`; string bodies
  default to text/plain. This conflicts with supported JSON endpoints, but does not establish
  that every operation or every deployed server rejects the request.
  [Transport](../src/main/providers/http.ts#L15-L28).
- **Gitea Actions:** the documented Gitea 1.24.7 task response is an envelope with
  `workflow_runs`; the implementation calls `.filter` on the response itself. A successful
  empty response can therefore become an error. This is a versioned-contract finding, not
  proof about every Gitea/Forgejo version.
  [Adapter](../src/main/providers/gitea.ts#L248-L270),
  [versioned schema](https://raw.githubusercontent.com/go-gitea/gitea/v1.24.7/templates/swagger/v1_json.tmpl).
- **Completeness/state:** collections stop at their first page without continuation metadata.
  Gitea checkout's all-state list lookup can miss a PR shown in the open list. Bitbucket's
  omitted-state request defaults to open, so its closed/all mapping needs correction as well.
  Fetch one PR directly for checkout and represent incomplete/failed/unsupported results.
  [Bitbucket](../src/main/providers/bitbucket.ts#L113-L118),
  [lookup](../src/main/providers/service.ts#L159-L163),
  [Bitbucket contract](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-get).

## Distribution and release readiness

The primary Linux unpacked build is verified; this does not certify the other formats or
native installation/update paths.

| Finding | Assessment and direction |
| --- | --- |
| Fresh development bootstrap | **Reproduced.** Electron 45 lazily provisions on import, but electron-vite directly requires its runtime path file. The documented install/dev sequence therefore fails on a fresh checkout. Provide explicit idempotent provisioning and test that clean launch. [Scripts/dependencies](../package.json#L18-L54), [instructions](../README.md#L214-L223). |
| Release/channel preparation | **Source, release-sensitive.** Preparation creates a draft without prerelease classification; the locked publisher reuses existing drafts without correcting that flag. Branch dispatch derives `latest` even for a beta package, and the draft input is unused. Use one validated version/channel and verify the assembled release before publication. Existing draft protection and stable-client prerelease rejection mitigate exposure; no current published-feed failure was demonstrated. [Workflow](../.github/workflows/release.yml#L6-L55), [channel selection](../.github/workflows/release.yml#L95-L132), [publish configuration](../electron-builder.config.cjs#L192-L203). |
| Optional package recipes | **Source/consumer contracts, not native-build verification.** Flatpak exports the default branch but bundles `stable`; Snap references project-root paths inconsistent with the checked-in layout; helper consumers hard-code `linux-unpacked` for ARM64; fallback pacman nests `.PKGINFO` below the archive root. Establish an architecture-aware staging contract and native-consumer checks, or identify these routes as experimental. [Flatpak](../scripts/build-flatpak.sh#L38-L43), [Snap](../snap/snapcraft.yaml#L20-L96), [fallback layout](../scripts/package-linux.py#L347-L400). |
| Signing and publication order | **Source/policy; actual release signatures unknown.** Configured fallback permits unsigned Windows/ad-hoc macOS builds. macOS signature verification follows upload and does not itself prove expected publisher identity or notarization. Define production versus development-fallback policy and verify before publication. Fixed HTTPS feeds, hashes and fuses are useful but prove different properties. [Release steps](../.github/workflows/release.yml#L135-L205). |
| Release privilege | **Source exposure, not observed compromise.** Release jobs use workflow-wide write permission, persisted checkout credentials and mutable action refs; packaging jobs receive some signing-related secrets beyond the relevant platform. Narrow those scopes and separate build verification from publishing. Ordinary PR CI is read-only; no fork-secret access was established. [Release permissions/steps](../.github/workflows/release.yml#L13-L14), [secret assignment](../.github/workflows/release.yml#L160-L168), [PR permissions](../.github/workflows/ci.yml#L9-L10). |

Keep grouped Windows/macOS architecture publication: those architectures share channel
metadata, so naive independent publishers can overwrite one another. Cross-packaging still
requires native runtime evidence.

Fresh beta profiles default to stable and can offer an older stable build. Downgrade support
is deliberate; whether a fresh beta install should select beta initially is a product-policy
question. Preserve existing preferences and make downgrade offers clear. This is separate
from the wrong-target defect H7.

## Documentation and assurance

### Correct the claims that influence user decisions

- [README staging](../README.md#L55) advertises discard with undo; the implementation and
  confirmation provide no app-level recovery. Correct the promise promptly. Building undo
  is a separate product decision, not the only way to resolve that contradiction.
- [Security networking](../SECURITY.md#L44-L45) omits default automatic update checking and
  downloading on supported builds. Document the default and off-switch; this is not evidence
  of telemetry.
- [Signing policy](../SECURITY.md#L54) and update UI copy overstate a guarantee that configured
  fallback builds do not establish. Actual publisher signatures require release evidence.
- [Packaging](packaging.md#L269-L271) claims Snap/Flatpak CI artifacts despite their local-only
  paths. Distinguish supported, buildable and actually exercised platforms.
- Provide a short first-success/recovery guide: system Git discovery, identity versus
  authentication, token capabilities, and limits of recovery after destructive actions.
  Existing Settings hints, token links and native pickers are useful foundations.
- Align [CONTRIBUTING](../CONTRIBUTING.md#L12-L20) with independent review and real-app
  verification requirements. Date/version acceptance records rather than turning historical
  observations into continuing guarantees.

### Improve assurance at the seams

The suite already checks real history replay, identity, persistence failure, submodule
isolation and updater cancellation. Preserve those behavioral oracles.

The highest-value additions are a small real-Electron critical-flow gate, adversarial IPC
and command-boundary cases, and realistic provider request/response contracts. The current
[provider mock](../tests/providers.test.ts#L23-L34) accepts unexpected requests and returns
success when its queue is exhausted. Node-only Vitest and a stubbed preload do not establish
that a complete UI write path works.

Integration fixtures also share ordered lifecycle state and inherit ambient Git configuration;
temporary directories alone do not fully isolate them. A focused run of
`tests/submodule.integration.test.ts` with `-t 'reports local changes inside an initialized checkout'`
reproduced the ordering dependency: the selected test fails at its file write because the
[preceding test](../tests/submodule.integration.test.ts#L86-L118) normally creates the submodule.
Make independently selectable cases establish prerequisites and use a controlled test Git
environment. Native Windows/macOS tests
run in release jobs, but their PR jobs primarily build/package; move relevant behavioral checks
earlier. Verify the advertised Git minimum rather than assuming the runner's Git covers it.

Aggregate coverage targets, a blanket formatting migration and mandatory live-account nightly
tests are lower-value starting points. Prefer failure-sensitive tests and explicitly scoped
native acceptance.

## Architectural decisions after challenge

| Decision | Recommendation | Strongest counterargument / constraint |
| --- | --- | --- |
| System Git | Retain. Make command intent and trust explicit. | Version/configuration variability is real; eliminating redundant subprocesses should precede considering another engine. |
| One IPC transport | Retain; strengthen decoding, return typing and authorization. | A typed channel and sender identity are not proof of user intent or resource permission. |
| One Zustand store | Retain; fix request ownership and progressively reduce duplicate writable state. | Derived selectors alone cannot prevent stale promises or closed-owner fallbacks. |
| Main-owned task state | Add a bounded inventory and reconnect snapshot to the existing manager. | Main already executes tasks; a durable job platform or tab-aware main process is unnecessary. |
| Shared provider model | Retain useful normalization; preserve capabilities, authoritative heads and completeness. | Forcing identical behavior hides real differences; validation should tolerate harmless extra fields. |
| Module extraction | Extract repeated operation/auth/request policy where changes prove useful. | Line-count-driven splitting can create indirection without improving correctness. |
| Performance | Share appropriate reads, then measure representative repositories. | Whole-repository caches can become stale after external Git activity; unmeasured virtualization is not the first remedy. |
| Distribution breadth | Keep primary targets; attach support claims to native evidence and explicit tiers. | Reducing formats may exclude users; keeping recipes as experimental is an alternative to treating all as release-qualified. |
| Documentation | Keep critical prerequisites/promises near actions; link focused guides. | Moving everything out of README hides important expectations and can multiply drift. |
| Feature expansion | Complete a finite work-preservation/correctness milestone, then choose from user demand. | Stabilization must not become open-ended; LFS visibility may be a core need, not optional polish. |

## Limitations and open decisions

- No live forge writes, credential-exfiltration demonstration, destructive updater install,
  or remote exploit was performed. Provider findings use source and documented contracts.
- Windows/macOS hardware, ARM64 runtime, package-manager installation and real previous-to-next
  updates were not exercised on this Linux host. Flatpak/Snap toolchains were unavailable;
  optional recipe conclusions are static. Published signatures, notarization and live channel
  completeness were not established.
- No large-repository latency/memory benchmark or formal assistive-technology assessment was run.
- Hostile metadata framing into synthetic commit records remains a reachability question;
  it was not promoted to a demonstrated exploit. Parser and operand validation should cover it.
- Product decisions remain: recoverable-discard guarantees, prerelease first-run channel,
  supported provider/server/package tiers, and whether LFS or inline review blocks users most.

See the [roadmap](roadmap-2026-11-10.md) for the recommended outcome order.
