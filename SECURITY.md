# Security policy

## Reporting a vulnerability

Email `contact@fradinni.fr` with a description, affected version, and a reproduction if
possible. Please do not open a public issue for security reports. We aim to acknowledge
within 72 hours and to publish a fix and advisory for confirmed issues.

## Threat model

Commit87 is a local desktop application that:

- executes the user's `git` binary against repositories the user chooses
- stores forge API tokens to call provider APIs
- renders repository content (file names, commit messages, diffs, release notes)

Trust boundaries:

| Boundary | Assumption |
| --- | --- |
| Renderer | Untrusted. Sandboxed, no Node, no credentials, CSP-restricted |
| IPC | Untrusted input. Every field re-validated in the main process |
| Git output | Untrusted data. Parsed, never executed; rendered as text |
| Repository content | Untrusted. Paths validated; no template or HTML execution |
| Provider responses | Untrusted. Parsed JSON, fields coerced, no HTML rendering |
| Secrets at rest | Protected by OS keychain when available |

## Controls

- `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webview`, no remote module
- Renderer served from `commit87://` with a strict CSP (`object-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`, no remote or inline scripts)
- Navigation, popups and `will-attach-webview` blocked; http(s) links open externally
- Electron fuses: no `runAsNode`, no `NODE_OPTIONS`, no CLI inspect, ASAR-only loading,
  ASAR integrity validation, no extra `file://` privileges, cookie encryption
- IPC restricted to the main window's `webContents` and to a compile-time channel table
- Path traversal rejected for repository files, worktrees and remote names
- Git spawned with `shell: false`; console accepts git-only, allow-listed subcommands and
  blocks config writes, aliases, `--exec` and `submodule foreach`
- Tokens passed via environment to an ephemeral credential helper scoped to the exact
  destination origin, never in `argv`, and redacted from all streamed output
- Tokens are only released to a host that exactly matches the integration's configured
  authority (provider-name heuristics and sole/pinned accounts cannot bypass it), and changing
  the endpoint clears the token unless a replacement is saved
- Tokens encrypted with `safeStorage` when available; otherwise stored `0600` with an
  explicit warning in Settings
- No telemetry, no analytics, no automatic network calls except forge API requests the
  user triggers and optional fetch-on-open (off by default)

## Out of scope

- Malicious repositories exploiting `git` itself (hooks run only when you invoke git
  operations, exactly as in a terminal; Commit87 does not `git config core.hooksPath` or
  install hook shims)
- Malicious forge servers reachable only by a token you configured
- Compromise of the OS keychain or of the user account
- Unsigned local builds; release builds are signed/notarized in CI

## Supported versions

Security fixes are issued for the latest minor release. Preview (`0.x`) releases are
supported on a best-effort basis.