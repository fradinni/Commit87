# Contributing

## Setup

```bash
npm install
npm run dev
```

Node 20+ and Git 2.30+ are required. No native modules are compiled.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. Keep commits focused and describe *why* in the message body.

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
3. Implement the case in `src/main/ipc/router.ts` with explicit validation.
4. Add a renderer wrapper in the store or a view.
5. `npm run typecheck` — the exhaustive `switch` will fail until the case exists.

## Adding a Git operation

1. Implement it in `src/main/git/repo.ts` using `runGit` and typed args.
2. Parse output in `parsers.ts` and add a parser test with realistic porcelain output.
3. Add an integration test against a temporary repository when it mutates state.
4. Wire it through the router and a view.

## Adding a provider feature

1. Extend `ProviderClient` in `src/main/providers/types.ts`.
2. Implement it in every provider (`github`, `gitlab`, `bitbucket`, `gitea`). Throw a
   clear message for genuinely unsupported features (for example Bitbucket releases).
3. Add request-shape tests with a mocked `fetch`.
4. Expose it through `ProviderService` and the router.

## Style

- TypeScript strict; no `any` in new code.
- Prefer named types and discriminated unions over optional bag objects.
- Keep renderer components small; extract parsing and formatting into `lib/`.
- CSS lives in `src/renderer/src/styles` and uses the CSS variables, never hard-coded
  colours.
- Do not add dependencies that bundle a Git implementation or a second state library.

## Reporting bugs

Include the GitGrove version (Settings → About), OS and architecture, Git version, and the
exact steps. Use Settings → Copy diagnostics to attach the environment block.