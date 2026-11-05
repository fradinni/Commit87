import {
  Boxes,
  CircleDot,
  Cloud,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Layers,
  Settings,
  Tag,
  TerminalSquare,
  Waypoints,
  Rocket
} from 'lucide-react'
import type { ReactNode } from 'react'
import { activeIdentity, useStore, type ViewId } from '../store'
import { initials } from '../lib/format'
import { Badge } from './ui'

interface NavItem {
  id: ViewId
  label: string
  icon: ReactNode
  count?: number
  hint?: string
}

export function Sidebar() {
  const view = useStore((state) => state.view)
  const setView = useStore((state) => state.setView)
  const repo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const branches = useStore((state) => state.branches)
  const tags = useStore((state) => state.tags)
  const worktrees = useStore((state) => state.worktrees)
  const stashes = useStore((state) => state.stashes)
  const submodules = useStore((state) => state.submodules)
  const pulls = useStore((state) => state.pulls)
  const detection = useStore((state) => state.detection)
  const appInfo = useStore((state) => state.appInfo)
  const integrations = useStore((state) => state.config?.integrations) ?? []
  const closeRepo = useStore((state) => state.closeRepo)
  const identity = activeIdentity()
  const integration = detection.accountId ? integrations.find((item) => item.id === detection.accountId) : undefined

  const workspace: NavItem[] = [
    { id: 'graph', label: 'Commit graph', icon: <GitCommitHorizontal size={16} /> },
    { id: 'files', label: 'Files & staging', icon: <Layers size={16} />, count: status?.files.length },
    {
      id: 'branches',
      label: 'Branches',
      icon: <GitBranch size={16} />,
      count: branches.filter((branch) => branch.type === 'branch').length
    },
    { id: 'worktrees', label: 'Worktrees', icon: <Waypoints size={16} />, count: worktrees.length },
    { id: 'submodules', label: 'Submodules', icon: <Boxes size={16} />, count: submodules.length },
    { id: 'tags', label: 'Tags', icon: <Tag size={16} />, count: tags.length },
    { id: 'stashes', label: 'Stashes', icon: <History size={16} />, count: stashes.length }
  ]

  const remote: NavItem[] = [
    { id: 'pulls', label: 'Pull requests', icon: <GitPullRequest size={16} />, count: pulls.length || undefined, hint: detection.provider },
    { id: 'releases', label: 'Releases', icon: <Rocket size={16} />, hint: detection.provider },
    { id: 'actions', label: 'Pipelines', icon: <CircleDot size={16} />, hint: detection.provider },
    { id: 'remotes', label: 'Remotes', icon: <Cloud size={16} />, count: repo?.remotes.length }
  ]

  const renderItem = (item: NavItem): ReactNode => (
    <button key={item.id} className={`nav-item ${view === item.id ? 'is-active' : ''}`} onClick={() => setView(item.id)}>
      <span className="nav-icon">{item.icon}</span>
      <span className="nav-label">{item.label}</span>
      {item.count ? <span className="nav-count">{item.count}</span> : null}
      {item.hint ? <span className="nav-hint">{item.hint}</span> : null}
    </button>
  )

  return (
    <aside className="sidebar">
      {repo ? (
        <>
          <div className="sidebar-repo">
            <div className="sidebar-repo-main">
              <span className="sidebar-repo-name">{repo.name}</span>
              <span className="sidebar-repo-path" title={repo.path}>
                {repo.path}
              </span>
            </div>
            <button className="sidebar-repo-close" onClick={() => void closeRepo()} title="Close repository">
              ×
            </button>
          </div>

          <nav className="nav">
            <div className="nav-section-label">Workspace</div>
            {workspace.map(renderItem)}
            <div className="nav-section-label">Remote</div>
            {remote.map(renderItem)}
          </nav>

          <button className={`nav-item ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')}>
            <span className="nav-icon">
              <Settings size={16} />
            </span>
            <span className="nav-label">Settings</span>
          </button>

          <button className="sidebar-identity" onClick={() => setView('settings')} title="Manage Git identities and integrations">
            <span className="avatar">{initials(identity?.name)}</span>
            <span className="identity-text">
              <span className="identity-name">{identity?.name ?? 'No identity configured'}</span>
              <span className="identity-email">{identity?.email ?? 'Add a Git identity'}</span>
            </span>
            <span className="identity-badges">
              {identity?.isDefault ? <Badge tone="green">default</Badge> : <Badge tone="neutral">identity</Badge>}
              {integration ? (
                <Badge tone="blue" title={integration.baseUrl}>
                  {integration.provider}
                </Badge>
              ) : null}
            </span>
          </button>
          <div className="sidebar-foot">
            <span>
              <TerminalSquare size={12} /> system git
            </span>
            <span className="sidebar-version">v{appInfo?.version ?? '0.1.0'}</span>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-empty">
            <Boxes size={22} />
            <p>No repository open</p>
            <span>Open, clone or create a repository to get started.</span>
          </div>
          <nav className="nav">
            <button className="nav-item" onClick={() => void closeRepo()}>
              <span className="nav-icon"><Boxes size={16} /></span>
              <span className="nav-label">Launchpad</span>
            </button>
          </nav>
          <div className="sidebar-spacer" />
          <button className={`nav-item ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')}>
            <span className="nav-icon">
              <Settings size={16} />
            </span>
            <span className="nav-label">Settings</span>
          </button>
          <div className="sidebar-foot">
            <span>system git</span>
            <span className="sidebar-version">v{appInfo?.version ?? '0.1.0'}</span>
          </div>
        </>
      )}
    </aside>
  )
}
