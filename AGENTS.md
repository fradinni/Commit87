# AGENTS.md

Commit87 is a cross-platform Electron + React desktop Git client that shells out to the
system `git` binary. Main process owns Git, files, secrets, and forge APIs; the renderer is
sandboxed and talks only through one typed IPC channel.

## Commands

```bash
npm install                 # Node 24+, system Git 2.30+
npm run dev                 # electron-vite dev with HMR
npm run typecheck           # strict TS for main/preload (node) and renderer (web)
npm run build               # typecheck + production bundles in out/
npm test                    # all Vitest suites (42 tests, needs git)
npx vitest run tests/parsers.test.ts            # one file
npx vitest run tests/parsers.test.ts -t "parses annotated"   # one test
npm run test:watch          # watch mode
```

There is **no lint script, ESLint, or Prettier config**. `npm run typecheck` and
`npm test` are the gates; match the existing formatting manually.

Packaging: `npm run icons`, `npm run pack:dir`, `npm run build:linux|win|mac`,
`npm run dist:flatpak`, `npm run dist:snap`,
`python3 scripts/package-linux.py [deb|rpm|pacman]`. Windows/macOS packaging must run on
matching hosts or CI (`.github/workflows/`). `npm run version:sync [x.y.z]` updates all
version files from `package.json`.

## Working in parallel

- Before starting a feature or code change, look for slices that can be done at the same
  time (main/git, IPC and shared types, renderer views, tests, docs) and hand each one to
  its own agent when that saves real time. Pin down the shared contract first, then let
  the agents build against it so their work meets in the middle.
- For analysis, split by question rather than sending one broad sweep: one focused agent
  per subsystem, file cluster, or behaviour, each asked for a specific answer, and you
  reconcile the findings and check them before acting.
- Do not fan out when it costs more than it saves: sequential steps, a file several agents
  would edit at once, or unclear requirements are yours to do in order. Treat anything an
  agent reports the same way you would treat your own draft — verify it.

## Changing code

- Never consider a change finished on your own say-so. Have it reviewed independently
  (a fresh pass with no memory of your reasoning: a second agent, a reviewer, or a
  deliberate adversarial read), then fix every real issue it finds before moving on.
- Run the gates after the fixes: `npm run typecheck`, the focused test file(s) for what
  you touched, then `npm test`. Green typecheck and tests are the minimum bar, not proof
  that the behaviour is right.
- If the change touches or could affect the UI (components, views, store, styles, IPC the
  renderer renders, menu, window chrome), validate it in the real app: `npm run dev`,
  drive the window, exercise the changed flow plus its empty and error states, and look at
  the result. A passing test or a compiled bundle is not a UI test.
- Keep `README.md` and `docs/` in step with the code in the same change: commands, IPC
  methods, settings, user-facing behaviour, packaging steps, screenshots. If a change
  makes a documented statement wrong, correct it now rather than leaving a follow-up.
- Say what was reviewed, what was found and fixed, and what you actually exercised in the
  UI. If a check could not be run, name it and the reason instead of implying it passed.

## Style

- TypeScript only, `strict` with `noUnusedLocals`/`noUnusedParameters`; never introduce
  `any`, `@ts-ignore`, or broad casts. Use `import type` for types and named exports.
- No semicolons, single quotes, 2-space indent, trailing commas, ~120-column lines.
- Imports: Node/Electron builtins, external packages, `@shared/*`, then relative modules,
  then CSS. Use `@shared/*` (both configs) and `@renderer/*` (renderer) aliases.
- PascalCase for React components and their files (`GraphView.tsx`, `ui.tsx` helpers may
  be mixed); camelCase for modules, functions, variables, hooks (`useStore`, `runGit`);
  SCREAMING_SNAKE_CASE for module constants; `IpcMethods`/`IpcChannel` for contracts.
- React: function components, hooks, zustand selectors; keep views small and move pure
  logic to `src/renderer/src/lib/`. One zustand store; do not add another state library.
- CSS lives in `src/renderer/src/styles` and uses the `--*` variables; no hard-coded colors.
- Errors: throw `Error` in main (`GitError`, `ProviderError` for context), never leak
  tokens or raw stacks. Renderer catches and calls `notifyError`; use toasts for user
  feedback. Do not swallow errors silently.
- Git: always spawn with argument arrays and `shell: false`; never interpolate a command
  string. Add operations in `src/main/git/repo.ts` via `runGit`, parse porcelain output in
  `parsers.ts`, and cover it with a parser/integration test.
- Validation/security: validate every IPC payload in `src/main/ipc/router.ts`; reject path
  traversal and absolute file arguments; keep credentials in the environment, never argv.
- Providers: implement `ProviderClient` for all four forges or throw a clear unsupported
  message; add mocked-`fetch` request tests.

## Structure

```
src/main/          Electron main: window/protocol, menu, store + secrets, tasks
src/main/git/      runner (spawn/env), parsers, typed repo operations
src/main/providers/ GitHub, GitLab, Bitbucket, Gitea clients + service/URL helpers
src/main/ipc/      single validated IPC router (typed decoder/handler tables) + grants
src/preload/       contextBridge: invoke + task/window/menu subscriptions only
src/shared/        pure domain types and the typed IPC contract (no Node/Electron)
src/renderer/src/  React UI: App, components, views, zustand store, lib, styles
tests/             Vitest: parsers, providers, credentials, diff/graph, git integration
build/             icons, installer/entitlement resources
scripts/ flatpak/ snap/  packaging helpers and native manifests
docs/              architecture, packaging, testing, screenshots
```

Rules by boundary: `shared` stays dependency-free; `main` validates and owns privileges;
`preload` exposes only the bridge; `renderer` has no Node, secrets, or direct network.
Extending IPC means: add to `IpcMethods` in `src/shared/ipc.ts`, add a type in
`src/shared/types.ts`, add the decoder and handler entries in `src/main/ipc/router.ts`, then wire
the store/view. Never bypass `src/renderer/src/lib/ipc.ts`.

Integration tests create temporary repositories under `os.tmpdir()` and clean up; never
touch user repos. Provider tests stub global `fetch`. Renderer effects must depend on
primitive values (repo path, ids) rather than refreshed objects, to avoid reload loops.

## Content and provenance

- Never commit or push material that names another application, its shipped artifacts or
  any inspection of them: no reverse-engineering notes, static-analysis write-ups, target
  inventories, extracted strings, screenshots, hashes or provenance tables.
- The same ban applies to code comments, docs, UI copy, commit messages, branch names,
  PR titles/descriptions and issue text. Describe Commit87 on its own merits.
- Feature comparisons stay generic ("most desktop Git clients…"), never a named product
  or vendor.
- If such material already exists on a branch, remove it and rewrite the history-sensitive
  text before opening or updating a pull request; do not add it to a new commit as a
  "follow-up" fix.
- Icons, copy, theme values and assets must be original work or permissively licensed
  third-party material with attribution, never derived from a competitor's build.
