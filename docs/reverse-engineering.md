# Reverse engineering notes: GitKraken 12.6.1 → GitGrove

This document records what was observed in the shipped GitKraken artifact, which
techniques produced each observation, what was deliberately **not** reproduced, and how
each finding shaped GitGrove. Everything below is static analysis of a local artifact; the
application was never instrumented for this work and no GitKraken code, asset, icon, string
or data file was copied into this repository.

## Target

| | |
| --- | --- |
| Product | GitKraken Desktop 12.6.1 (`com.axosoft.GitKraken`, Flathub stable) |
| Artifact | `/var/lib/flatpak/app/com.axosoft.GitKraken/…/files/extra/gitkraken` |
| Main bundle | `resources/app.asar` (296 MB, SHA-256 `28d78bfc…c60a4`) |
| Runtime | Electron 41-class Chromium, `zypak` sandbox wrapper, 732 MB installed |
| Tooling | REA (`open_binary`, `analyze_javascript_application`, `inspect_analysis_view`, `inspect_electron_fuses`) plus direct ASAR header inspection |

## Observations

### 1. It is an Electron app with a very large monolithic bundle

`package.json` (read from the ASAR) declares:

- `main: ./src/main/static/main.bundle.js`
- `productName: GitKraken`, version `12.6.1`
- 52 524 ASAR entries, of which 41 063 are "relevant" JavaScript/JSON sources
- a 7 MB `main.bundle.js`, a 13 MB `render.bundle.js`, and a full Monaco build
- dependencies including `@axosoft/nodegit`, `node-pty`, `nsfw` (native file watching),
  `@octokit/rest`, `@gitbeaker/node`, `bitbucket-v2`, `typed-rest-client`, `react`,
  `redux`, `redux-saga`, `@xterm/xterm`, `@sentry/electron`

The application graph analysis (8 selected sources) recovered **2 240 modules**,
1 572 924 visited AST nodes and 7 204 findings. Two lessons were immediate:

- monaco + redux + a 20 MB renderer chunk is the main reason the product feels heavy;
- the git layer is a native addon (`nodegit`) rather than the Git binary.

GitGrove therefore uses a React 19 renderer with a single zustand store, no global state
framework, a system `git` subprocess layer, and code splitting left to Vite.

### 2. Electron fuses (runtime hardening)

`inspect_electron_fuses` on the shipped ELF found a `wire_version 1` sentinel at file
offset 31 885 040 with:

| Fuse | State | Reading |
| --- | --- | --- |
| `RunAsNode` | enabled | the binary can run as plain Node (used by CLI helpers) |
| `EnableNodeOptionsEnvironmentVariable` | enabled | `NODE_OPTIONS` is honoured |
| `EnableNodeCliInspectArguments` | disabled | `--inspect` is not accepted |
| `EnableEmbeddedAsarIntegrityValidation` | disabled | ASAR integrity is not enforced |
| `OnlyLoadAppFromAsar` | disabled | app code may load from disk |
| `GrantFileProtocolExtraPrivileges` | enabled | `file://` keeps extra privileges |
| `EnableCookieEncryption` | disabled | cookies are not encrypted at rest |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled | — |

GitGrove flips the security-relevant ones: `runAsNode: false`,
`enableNodeOptionsEnvironmentVariable: false`, `onlyLoadAppFromAsar: true`,
`enableEmbeddedAsarIntegrityValidation: true`, `grantFileProtocolExtraPrivileges: false`,
`enableCookieEncryption: true`. Disabling the `file://` privileges is why GitGrove serves
its renderer from a privileged `gitgrove://` scheme instead of `file://`.

The final packaged binary was re-inspected with the same REA fuse reader to confirm the
result (SHA-256 `ec93fc9f…095b4`, sentinel at offset 31 318 896):

| Fuse | GitKraken 12.6.1 | GitGrove 0.1.0 |
| --- | --- | --- |
| `RunAsNode` | enabled | **disabled** |
| `EnableCookieEncryption` | disabled | **enabled** |
| `EnableNodeOptionsEnvironmentVariable` | enabled | **disabled** |
| `EnableNodeCliInspectArguments` | disabled | disabled |
| `EnableEmbeddedAsarIntegrityValidation` | disabled | **enabled** |
| `OnlyLoadAppFromAsar` | disabled | **enabled** |
| `GrantFileProtocolExtraPrivileges` | enabled | **disabled** |
| `WasmTrapHandlers` | disabled | enabled (Electron 41 default) |

### 3. Credential handling: askpass over a local socket

`src/js/redux/domain/AskPass/AskPass.sh` and `AskPassClient.js` were extracted from the
ASAR. The shell wrapper is three lines:

```sh
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 "$GITKRAKEN_BINARY_PATH" "$GITKRAKEN_ASKPASS_SCRIPT_PATH" $PPID "$@"
```

The client parses `GITKRAKEN_ASKPASS_SESSION_ID`, `…_SIGN`, `GITKRAKEN_SOCKET_SERVICE_PORT`,
`GITKRAKEN_ASKPASS_SSH_KEY`, `…_SIGN` and `GIT_EXECUTOR_COMMAND_ID` from the environment,
classifies prompts (`Username for …`, `Password for …`, `Enter passphrase for key …`) and
talks to a service on `127.0.0.1` to obtain the answer. A separate
`GitSequenceEditorClient.js` uses the same socket pattern for rebase todo files.

Transferable idea, different implementation: a GUI git client must never block on a TTY
prompt. GitGrove sets `GIT_TERMINAL_PROMPT=0` and supplies credentials non-interactively
through an ephemeral `credential.helper` that reads from the environment, so there is no
long-lived localhost credential service to attack or misconfigure. A future askpass bridge
would keep the same environment-only contract.

### 4. Git execution model

The strings catalogue and the child-process relationships show hooks orchestration:

- `resources/hooks/hook.template` runs `$GKC_HOOKS_REAL_PATH/$HOOKNAME`, wraps output in
  `_GKC_HOOK_BEGIN_…` / `_GKC_HOOK_END_…` markers, prints an explicit exit-code marker, and
  uses `644644` to signal "hook present but not executable".
- `GIT_CONFIG_PARAMETERS` is explicitly unset before calling user hooks.
- `resources/cli/unix/gkcrc` + `gkc` implement an embedded terminal with prompt markers
  (`\e[1314~`) and a `gkc setCwd` hook.

GitGrove takes the opposite stance on scope: it does not install hook shims or wrap the
prompt, so hooks behave exactly as they do in a terminal. The shell-free git console
replaces the `gkc` prompt integration with an explicit allow-listed command runner.

### 5. Process topology

The fuse state (`RunAsNode` enabled) and the bootstrap files
(`src/main/static/cli.js`, `startMainProcess.js`, `parseArgv.js`) show at least a main
process, a renderer, a `requestHandler` entry point, a `pty-host` bundle, and a CLI
re-entering the same binary with `ELECTRON_RUN_AS_NODE=1`. GitGrove keeps one main process
and one renderer: task streaming and IPC cover what the pty-host/request-handler split
does, with far fewer moving parts.

### 6. Product surface

The bundled `src/strings.json` (5 663 strings, plus a 441 KB locale catalogue) was
inventoried to map the feature surface. It confirms, among many others:

- worktrees as first-class objects: `ContextMenu-CreateWorktreeFrom`,
  `PromptForRemoveWorktree`, `ForceRemoveWorktreeButtonLabel`, lock messages,
  `Error-PruneWorktreesFailed`;
- identity and integration management (`Registration-ChangeEmail`, org settings, SSO);
- AI, boards, issue tracking, insights, team management, cloud workspaces, and a
  subscription/licensing model.

GitGrove's scope is the intersection of that surface with "Git, code and repo management":
worktrees, branches, tags, stash, releases, pull requests and pipelines. Boards, issues,
wikis, AI chat and org administration are intentionally out of scope.

### 7. Known limitations of this analysis

- The bundle is minified production output; the JavaScript graph is partial
  (`coverage.status = partial`, 100 000 semantic unknowns retained). Absence of a
  relationship in the graph is not evidence of absence in the product.
- `EnableEmbeddedAsarIntegrityValidation` is disabled on Linux because Electron only
  compiles that check for macOS/Windows; the observation does not imply the macOS build is
  unverified.
- No dynamic/runtime tracing was performed on GitKraken; all behaviour claims above are
  static and cited to file paths, offsets or strings.
- The Flatpak manifest and the 732 MB install size were read for packaging inspiration
  (Electron base app, zypak, bundled Git/LFS), not copied.

## Clean-room rules applied

1. No file from the GitKraken artifact is present in this repository. Icons, copy, theme
   and layout are original; the palette and spacing were chosen independently.
2. API shapes were derived from what the app does (repos, PRs, releases, runs), then
   implemented against the public forge APIs documented by GitHub, GitLab, Bitbucket and
   Gitea.
3. Familiar interaction patterns (graph + details panel, staging panel + commit box,
   command palette) are ideas, not copied assets or code.
4. Git interaction is implemented against `git`'s documented porcelain output, not against
   GitKraken's internal data model.

## Consequences in GitGrove

| Finding | Decision |
| --- | --- |
| 296 MB ASAR, 7 MB main bundle, 13 MB renderer, Monaco | small renderer, no Monaco, `highlight.js` for reading files, graph and diff parsers ~200 lines each |
| NodeGit/libgit2 git layer | system `git` subprocess with porcelain v2 parsing |
| Insecure fuses (`RunAsNode`, `NODE_OPTIONS`, extra `file://`) | hardened fuses + custom protocol |
| Askpass socket service | environment-only credential helper, `GIT_TERMINAL_PROMPT=0` |
| Hook shims with output markers | hooks untouched; console allow-list instead |
| Subscription-gated breadth | MIT, offline-first core, forge tokens optional |
| Worktrees buried in context menus | dedicated worktree view and per-worktree repository opening |