# Getting started

Commit87 runs on the Git you already have. This guide covers the two things that decide
whether a first commit and the first push work: the Git binary the app is allowed to run,
and the difference between who authors a commit and which account may talk to a remote.

## System Git

Commit87 shells out to a real `git`; there is no bundled Git, libgit2 or Git
re-implementation in the desktop packages. Flatpak and Snap builds are the exception
because their sandbox cannot execute host binaries, so they stage Git inside the bundle.

- **Requirement:** Git 2.30+ must be on `PATH` unless you choose a binary. Node.js is not
  needed to run a packaged build; building from source needs Node 24+.
- **Discovery:** at startup Commit87 runs `git --version` against `git` from `PATH` and
  remembers the result. The launchpad shows the detected version, and **Settings → System
  Git** shows the version and path, or the error when nothing usable was found.
- **Custom binary:** **Settings → System Git → Choose…** opens a native file picker. Only
  an absolute, regular, executable file whose `--version` succeeds is accepted, and the
  same file is checked again before every spawn. A binary typed into settings is not
  accepted, and **Use system Git** returns to `PATH`.
- **Automation:** `COMMIT87_GIT` in the process environment is a deliberate local override
  for scripted runs and tests. It is never read from the renderer.
- **Missing or stale runtime (source builds):** `npm run dev` and `npm run start` provision
  the Electron runtime first; `npm run ensure:electron` repairs it and
  `npm run ensure:electron -- --check` only reports. See the README for the exact commands.

Git configuration, hooks, filters, signing and `includeIf` rules are the system Git's, and
Commit87 does not install hook shims or rewrite `core.hooksPath`. Prefer the built-in git
console over an external terminal when you want to see exactly what the app runs.

## Open a repository

Use **Open** (`Ctrl/Cmd+O`), **Clone** (`Ctrl/Cmd+Shift+O`) or **Init**. Clone works over
HTTPS or SSH, shallow or full, and can create a bare repository; bare repositories open
with graph, branches, tags and remotes but refuse worktree operations with an explanation.

Repository access is granted by the main process, not by a renderer string:

- a folder returned by the native picker;
- an OS launch argument, `file://` hand-off or `commit87://` deep link;
- a clone or init destination derived from a granted folder;
- a linked worktree created next to or inside a granted folder;
- a remembered recent repository (recents are loaded as grants at startup).

The canonical real path and, for a linked worktree, the shared common Git directory are
checked before every operation and again at use time. If a repository was moved, deleted
and re-created, or opened through a path the app never saw the user choose, the operation is
refused. Reopen it with the picker. Removing a repository from the recent list also revokes
its grant. Grants live in `grants.json` next to the app profile (see
[recovery](recovery.md#app-profile-and-grants)).

## Identity versus authentication

These are separate, and mixing them up is the usual reason a commit has the wrong author or
a push fails:

| Concept | What it controls | Where it lives |
| --- | --- | --- |
| **Identity** | The author and committer name/email recorded in commits, tags and stashes; the SSH key used for Git remotes; the optional GPG key/signature | Settings → Identities, plus a per-repository default and a per-commit pick |
| **Forge account** | HTTPS access to a remote and the provider API (pull requests, releases, pipelines) | Settings → Integrations, matched to the destination or pinned per repository |

Identity resolution happens in the main process, in this order:

1. the identity explicitly picked for this operation;
2. the repository's default identity;
3. the identity Git resolves for that repository (`--local` first, then the effective
   value, so `includeIf` and global configuration still apply);
4. the application default identity.

A repository identity keeps the application identity's SSH key and authentication settings
but **not** its signing settings, so work authored under a repository identity is not
silently signed with an unrelated key. Continue after an interrupted merge or rebase also
commits as the repository's author, not as the application default.

An identity does not grant network access. An integration token does not change authorship.
SSH remotes use the identity's key or your SSH agent and are never sent a forge token.

## Tokens and scopes

Add an integration in **Settings → Integrations**, paste a token and press **Test**. The
token is stored in the OS credential store when `safeStorage` is available, otherwise in
`secrets.json` with mode `0600` and a warning in Settings.

| Forge | What the app asks for | Used for |
| --- | --- | --- |
| GitHub / GitHub Enterprise | Personal access token with repository and workflow scopes | Git over HTTPS, pull requests, releases, Actions |
| GitLab (including self-hosted) | Personal access token with the `api` scope | Git over HTTPS, merge requests, releases, pipelines |
| Bitbucket Cloud | Atlassian API token or repository access token | Git over HTTPS, pull requests, Pipelines |
| Gitea / Forgejo | Access token with repository and action scopes | Git over HTTPS, pull requests, releases, Actions |

Settings links each provider's token page and shows the same hint next to the base URL.
Use the forge's own documentation for fine-grained permissions; a token that can read a
repository but not write to it will browse and clone but fail on push. Commit87 does not
request additional scopes on its own.

Tokens are only released to a destination whose host (and explicit port) matches the
integration's authority. The documented API-host mappings are honoured — for example
`api.github.com`↔`github.com` and `api.bitbucket.org`↔`bitbucket.org` — and an API path such
as `/api/v3`, `/api/v4` or `/2.0` does not change the host. Plain `http` is refused except
on loopback. Provider-name heuristics and a repository's pinned account can choose between
accounts that already match, but they never authorize one, and there is no sole-account
fallback. If no account matches, the operation runs anonymously: public clones still work,
private ones fail because Git cannot prompt for credentials.

## When a token is refused

- **The endpoint changed.** Provider, base URL host, explicit port, path or clone host
  changes invalidate the authority the token was issued for, so the stored token is
  cleared. Edit the integration and paste the token again for the new destination. Label,
  username and identity edits keep it.
- **The profile predates authority binding.** Version 1 stored tokens without a destination
  fingerprint and let them survive endpoint edits. Those tokens are dropped on first load
  and must be entered once more; Commit87 cannot know which server they belonged to and
  will not re-bind them to today's endpoint.
- **An explicit account was chosen for another host.** Clone and checkout with an explicit
  account fail with an actionable message instead of quietly using a different account.
  Automatic selection treats a renderer-detected account as a preference only.
- **The remote is SSH.** Tokens are not offered to SSH remotes. Check the identity's key,
  `GIT_SSH_COMMAND`/SSH agent and the remote URL instead.
- **The token is valid but cannot write.** Check the forge's scopes, SSO authorization for
  the organization and branch protection; the error comes from the forge, not from the app.

## Next

- [Recovery](recovery.md) — what is recoverable after discard, submodule removal and an
  interrupted operation.
- [Architecture](architecture.md) — the process boundary, grant store, identity and
  credential policy in detail.
- [Packaging](packaging.md) — supported platforms, release verification and signing.
