# Contributing

## Setup

```bash
npm install                 # or npm ci
npm run ensure:electron     # repair the runtime if dev cannot start
npm run dev
```

Node 24+ and Git 2.30+ are required. No native modules are compiled. `npm run dev` and
`npm run start` provision Electron themselves; `npm run ensure:electron -- --check` only
reports and never downloads. `npm run build` produces the production bundles in `out/`.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. `npm run typecheck` covers main/preload and renderer under `strict`
with `noUnusedLocals`/`noUnusedParameters`; `npm test` runs the Vitest suites against real
Git in temporary repositories. There is no lint script or formatter config, so match the
existing style: no semicolons, single quotes, 2-space indent, trailing commas, ~120 columns.

Run the focused test file(s) for what you touched before the full suite, and add a
regression case for a defect rather than only fixing the code.

## Review and verification

- Every change gets an independent review before it is considered finished: a fresh pass
  with no memory of the author's reasoning, a second agent or reviewer, or a deliberate
  adversarial read. Fix every real issue it finds, then re-run the gates.
- A passing test or a compiled bundle is not UI verification. If the change touches
  components, views, the store, styles, menus, window chrome or IPC the renderer renders,
  run `npm run dev`, drive the affected flow plus its empty and error states, and look at
  the result.
- For packaging, update or native-surface changes, exercise the affected artifact and its
  installation boundary on a matching host. Unit tests and static checks do not prove a
  Windows installer, a macOS signature, an AppImage replacement or a Flatpak/Snap build.
  If you could not run it, say so and leave the claim labelled as unverified rather than
  implying it passed.
- Keep `README.md`, `SECURITY.md`, `CONTRIBUTING.md` and `docs/` in step with the code in
  the same change: commands, IPC methods, settings, user-facing behaviour, packaging steps
  and screenshots. If a change makes a documented statement wrong, correct it now.

Report what was reviewed, what was found and fixed, which tests and UI scenarios were
exercised, and what could not be run and why.

## Code layout

| Path | Rules |
| --- | --- |
| `src/shared/` | Pure types and the IPC contract. No Electron or Node imports |
| `src/main/` | Full privileges. Validate every IPC argument; never interpolate shell strings |
| `src/preload/` | Only expose the `invoke` helper and event subscriptions |
| `src/renderer/` | No Node, no secrets, no direct network. Call the typed IPC helper |
| `tests/` | Vitest; integration tests must use a temporary repository |

## Adding an IPC channel

1. Add the request/response types in `src/shared/ipc.ts` (`IpcMethods`).
2. Add domain types in `src/shared/types.ts` if needed.
3. Add the strict decoder to `DECODERS` and the handler to the handler table in
   `src/main/ipc/router.ts`. Both tables are type-checked against the declared contract.
4. Add a renderer wrapper in the store or a view, through `src/renderer/src/lib/ipc.ts`.
5. `npm run typecheck` fails until the decoder, handler and response type agree.

Never cast a payload in the router, never accept a renderer string as authority for a path,
and never let a truthy value stand in for a boolean.

## Adding a Git operation

1. Implement it in `src/main/git/repo.ts` using `runGit` and typed args; pass file lists
   with literal-pathspec semantics and revisions through the validators.
2. Parse output in `parsers.ts` and add a parser test with realistic porcelain output.
3. Add an integration test against a temporary repository when it mutates state.
4. Wire it through the router and a view.

## Adding a provider feature

1. Extend `ProviderClient` in `src/main/providers/types.ts` and declare the capability.
2. Implement it in every provider (`github`, `gitlab`, `bitbucket`, `gitea`). Throw a
   clear message for genuinely unsupported features (for example Bitbucket releases), and
   reject unsupported intent in main before an HTTP write.
3. Add request-shape tests with the strict mocked `fetch`; an unexpected request fails.
4. Expose it through `ProviderService` and the router.

## Style

- TypeScript strict; no `any`, no `@ts-ignore`, no broad casts. Use `import type`.
- Prefer named types and discriminated unions over optional bag objects.
- Keep renderer components small; extract parsing and formatting into `lib/`.
- CSS lives in `src/renderer/src/styles` and uses the CSS variables, never hard-coded
  colours.
- Do not add dependencies that bundle a Git implementation or a second state library.

## Content and provenance

- Do not commit material that names another application, its shipped artifacts or any
  inspection of them: no reverse-engineering notes, static-analysis write-ups, target
  inventories, extracted strings, screenshots, hashes or provenance tables.
- The same applies to code comments, docs, UI copy, commit messages, branch names and PR
  text. Describe Commit87 on its own merits; comparisons stay generic ("most desktop Git
  clients…"), never a named product or vendor.
- Icons, copy, theme values and assets must be original work or permissively licensed
  third-party material with attribution, never derived from a competitor's build.

## Reporting bugs

Include the Commit87 version (Settings → About & diagnostics), OS and architecture, Git
version, and the exact steps. Use Settings → About & diagnostics → Copy diagnostics to
attach the environment block.
