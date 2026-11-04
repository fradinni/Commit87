import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Github,
  Plus,
  Settings,
  Sparkles,
  Trash2
} from 'lucide-react'
import { useStore } from '../store'
import { formatRelativeTime } from '../lib/format'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { Logo } from '../components/TitleBar'

export function Launchpad({
  onOpen,
  onClone,
  onInit
}: {
  onOpen: () => void
  onClone: () => void
  onInit: () => void
}) {
  const recent = useStore((state) => state.recent)
  const config = useStore((state) => state.config)
  const appInfo = useStore((state) => state.appInfo)
  const openRepo = useStore((state) => state.openRepo)
  const removeRecent = useStore((state) => state.removeRecent)
  const pinRecent = useStore((state) => state.pinRecent)
  const notifyError = useStore((state) => state.notifyError)
  const setView = useStore((state) => state.setView)
  const identities = config?.identities ?? []
  const integrations = config?.integrations ?? []
  const hasToken = integrations.some((account) => account.hasToken)
  const pinned = recent.filter((repo) => repo.pinned)
  const unpinned = recent.filter((repo) => !repo.pinned)
  const ordered = [...pinned, ...unpinned]

  const open = async (path: string): Promise<void> => {
    try {
      await openRepo(path)
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <div className="launchpad">
      <section className="launch-hero">
        <div className="launch-hero-text">
          <div className="launch-eyebrow">
            <Sparkles size={13} /> Git, without the noise
          </div>
          <h1>
            Your repo,
            <br />
            <span>in focus.</span>
          </h1>
          <p>
            A fast desktop Git client built around system Git. Branch, review, worktree, tag, release and run pipelines —
            without leaving the keyboard.
          </p>
          <div className="launch-actions">
            <Button variant="primary" icon={<FolderOpen size={16} />} onClick={onOpen}>
              Open repository
            </Button>
            <Button variant="outline" icon={<FolderGit2 size={16} />} onClick={onClone}>
              Clone
            </Button>
            <Button variant="ghost" icon={<Plus size={16} />} onClick={onInit}>
              Create new
            </Button>
          </div>
          <div className="launch-meta">
            <span>
              <GitCommitHorizontal size={13} /> {appInfo?.git.available ? appInfo.git.version.replace('git version ', 'git ') : 'git not found'}
            </span>
            <span>
              <GitBranch size={13} /> system git, your identity
            </span>
          </div>
        </div>
        <div className="launch-hero-art" aria-hidden="true">
          <div className="hero-card hero-card-back" />
          <div className="hero-card">
            <div className="hero-card-top">
              <Logo size={26} />
              <span>main</span>
              <Badge tone="green">clean</Badge>
            </div>
            <div className="hero-commit">
              <span className="hero-node" />
              <div>
                <strong>Ship worktrees and releases</strong>
                <span>you · 2m ago</span>
              </div>
              <Badge tone="purple">v1.4.0</Badge>
            </div>
            <div className="hero-commit">
              <span className="hero-node blue" />
              <div>
                <strong>feat: per-remote identities</strong>
                <span>you · 1h ago</span>
              </div>
            </div>
            <div className="hero-commit">
              <span className="hero-node purple" />
              <div>
                <strong>fix: pull request checkout</strong>
                <span>teammate · 3h ago</span>
              </div>
            </div>
            <div className="hero-card-foot">
              <span>
                <CheckCircle2 size={12} /> pipeline passed
              </span>
              <span>3 worktrees</span>
            </div>
          </div>
        </div>
      </section>

      <section className="launch-section">
        <div className="launch-section-head">
          <div>
            <h2>Recent repositories</h2>
            <p>{ordered.length ? `${ordered.length} on this machine` : 'Nothing here yet'}</p>
          </div>
          {ordered.length ? (
            <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={onOpen}>
              Browse…
            </Button>
          ) : null}
        </div>
        {ordered.length === 0 ? (
          <div className="launch-empty">
            <EmptyState
              icon={<FolderGit2 size={22} />}
              title="Open your first repository"
              description="GitGrove works with any local Git repository, including linked worktrees."
              action={
                <div className="row-gap">
                  <Button variant="primary" size="sm" onClick={onOpen}>
                    Open folder
                  </Button>
                  <Button variant="outline" size="sm" onClick={onClone}>
                    Clone a URL
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <div className="repo-grid">
            {ordered.map((repo) => (
              <div key={repo.path} className={`repo-card ${repo.pinned ? 'is-pinned' : ''}`}>
                <button className="repo-card-main" onClick={() => void open(repo.path)}>
                  <span className="repo-card-icon">
                    <FolderGit2 size={19} />
                  </span>
                  <span className="repo-card-text">
                    <span className="repo-card-name">{repo.name}</span>
                    <span className="repo-card-path">{repo.path}</span>
                  </span>
                  <ArrowRight size={15} className="repo-card-arrow" />
                </button>
                <div className="repo-card-foot">
                  <span>{formatRelativeTime(repo.lastOpenedAt)}</span>
                  <div>
                    <IconButton
                      label={repo.pinned ? 'Unpin' : 'Pin'}
                      className={repo.pinned ? 'is-active' : ''}
                      onClick={() => void pinRecent(repo.path, !repo.pinned).catch(notifyError)}
                    >
                      <Sparkles size={13} />
                    </IconButton>
                    <IconButton label="Remove from recent" onClick={() => void removeRecent(repo.path).catch(notifyError)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="launch-setup">
        <div className="setup-card">
          <span className="setup-icon">
            <GitBranch size={17} />
          </span>
          <div>
            <h3>Git identities</h3>
            <p>
              {identities.length
                ? `${identities.length} identity${identities.length === 1 ? '' : 'ies'} — commits use ${identities.find((item) => item.isDefault)?.email ?? identities[0]?.email}.`
                : 'Add a name and email for commits. Switch identities per repository or per push.'}
            </p>
          </div>
          <Button size="sm" variant={identities.length ? 'ghost' : 'outline'} onClick={() => setView('settings')}>
            {identities.length ? 'Manage' : 'Add identity'}
          </Button>
        </div>
        <div className="setup-card">
          <span className="setup-icon blue">
            <Cloud size={17} />
          </span>
          <div>
            <h3>Forge integrations</h3>
            <p>
              {hasToken
                ? `${integrations.filter((item) => item.hasToken).length} connected — GitHub, GitLab, Bitbucket or Gitea.`
                : 'Connect a token to manage pull requests, releases and pipelines from GitGrove.'}
            </p>
          </div>
          <Button size="sm" variant={hasToken ? 'ghost' : 'outline'} onClick={() => setView('settings')}>
            {hasToken ? 'Manage' : 'Connect'}
          </Button>
        </div>
        <div className="setup-card">
          <span className="setup-icon purple">
            <Github size={17} />
          </span>
          <div>
            <h3>Keyboard first</h3>
            <p>Open the command palette with Ctrl/Cmd+K and the git console with Ctrl/Cmd+J.</p>
          </div>
          <Button size="sm" variant="ghost" icon={<Settings size={14} />} onClick={() => setView('settings')}>
            Preferences
          </Button>
        </div>
      </section>

      <footer className="launch-foot">
        <span>
          GitGrove {appInfo?.version ?? '0.1.0'} · Electron {appInfo?.electron ?? '—'} · {appInfo?.arch ?? ''}
        </span>
        <span>{appInfo?.configPath}</span>
      </footer>
    </div>
  )
}
