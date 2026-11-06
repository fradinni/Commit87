import { useEffect, useState } from 'react'
import {
  ChevronDown,
  CloudDownload,
  CloudUpload,
  Command,
  Download,
  GitBranch,
  PanelLeft,
  RefreshCw,
  SquareTerminal,
  Minus,
  Square,
  X
} from 'lucide-react'
import { useStore, activeIdentity } from '../store'
import { repoPathKey } from '../lib/tabs'
import { call } from '../lib/ipc'
import { Badge, IconButton, Spinner } from './ui'

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0c1518" />
      <path d="M21.125 9.625A7.625 7.625 0 1 0 21.125 22.375" stroke="#3ddc97" strokeWidth="2.25" strokeLinecap="round" />
      <circle cx="21.125" cy="22.375" r="2" fill="#f4fbf8" />
      <circle cx="21.125" cy="22.375" r="0.8125" fill="#0c1518" />
    </svg>
  )
}

export function TitleBar({ onPalette, onPush }: { onPalette: () => void; onPush: () => void }) {
  const repo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const detection = useStore((state) => state.detection)
  const task = useStore((state) => state.task)
  const tasks = useStore((state) => state.tasks)
  const consoleOpen = useStore((state) => state.consoleOpen)
  const toggleConsole = useStore((state) => state.toggleConsole)
  const updateStatus = useStore((state) => state.updateStatus)
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const setSidebarOpen = useStore((state) => state.setSidebarOpen)
  const notifyError = useStore((state) => state.notifyError)
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const platform = window.commit87.platform
  const isMac = platform === 'darwin'
  const repoKey = repo ? repoPathKey(repo.path, platform) : null
  const repoBusy = repoKey
    ? Object.values(tasks).some((item) => item.repoPath && repoPathKey(item.repoPath, platform) === repoKey)
    : Object.keys(tasks).length > 0
  const taskRepo = task?.repoPath?.split(/[\\/]/).filter(Boolean).pop()

  useEffect(() => {
    void call('window.isMaximized', undefined).then(setMaximized)
    return window.commit87.onWindowState((state) => setMaximized(state.maximized))
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const startSync = async (kind: 'fetch' | 'pull'): Promise<void> => {
    if (!repo) return
    const identity = activeIdentity()
    try {
      if (kind === 'fetch') {
        await call('git.fetch', { repoPath: repo.path, prune: true, accountId: detection.accountId })
      } else if (kind === 'pull') {
        await call('git.pull', {
          repoPath: repo.path,
          identityId: identity?.id,
          accountId: detection.accountId
        })
      }
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <header className="titlebar" onDoubleClick={() => void call('window.maximizeToggle', undefined)}>
      <div className="titlebar-left">
        {!isMac ? (
          <div className="titlebar-brand">
            <Logo />
            <span className="brand-name">Commit87</span>
          </div>
        ) : (
          <div className="titlebar-brand mac-offset">
            <Logo />
            <span className="brand-name">Commit87</span>
          </div>
        )}
        <IconButton label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSidebarOpen(!sidebarOpen)} className="no-drag">
          <PanelLeft size={16} />
        </IconButton>
        {repo ? (
          <div className="repo-identity" onDoubleClick={(event) => event.stopPropagation()}>
            <button className="repo-switcher no-drag" onClick={() => setMenuOpen((open) => !open)}>
              <span className="repo-name">{repo.name}</span>
              {repo.worktree ? <Badge tone="purple">worktree</Badge> : null}
              {detection.provider ? <Badge tone="outline">{detection.provider}</Badge> : null}
              <ChevronDown size={13} />
            </button>
            {menuOpen ? (
              <>
                <div className="click-catcher" onClick={() => setMenuOpen(false)} />
                <div className="dropdown repo-dropdown">
                  <div className="dropdown-header">{repo.path}</div>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      void useStore.getState().closeRepo()
                    }}
                  >
                    Close tab
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      useStore.getState().closeOtherTabs()
                    }}
                  >
                    Close other tabs
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      useStore.getState().closeAllTabs()
                    }}
                  >
                    Close all tabs
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      void useStore.getState().refreshAll()
                    }}
                  >
                    Refresh repository
                  </button>
                </div>
              </>
            ) : null}
            {status?.branch ? (
              <span className="branch-pill">
                <GitBranch size={13} />
                {status.branch}
                {status.ahead > 0 ? <span className="ahead">↑{status.ahead}</span> : null}
                {status.behind > 0 ? <span className="behind">↓{status.behind}</span> : null}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="titlebar-placeholder">Repositories · branches · worktrees · releases · pipelines</span>
        )}
      </div>

      <div className="titlebar-right no-drag">
        {updateStatus && ['available', 'downloading', 'ready'].includes(updateStatus.phase) ? (
          <button
            className={`update-chip update-chip-${updateStatus.phase}`}
            title={
              updateStatus.phase === 'ready'
                ? 'An update is downloaded and ready to install'
                : updateStatus.phase === 'downloading'
                  ? 'Update download in progress'
                  : `Commit87 ${updateStatus.version ?? ''} is available`
            }
            onClick={() => {
              useStore.getState().setSettingsTab('updates')
              useStore.getState().setView('settings')
            }}
          >
            <Download size={13} />
            <span>
              {updateStatus.phase === 'ready'
                ? 'Restart to update'
                : updateStatus.phase === 'downloading'
                  ? `Updating ${updateStatus.progress?.percent ?? 0}%`
                  : `v${updateStatus.version ?? ''} available`}
            </span>
          </button>
        ) : null}
        {task ? (
          <span className="task-chip" title={task.title}>
            <Spinner size={12} />
            <span>{taskRepo ? `${taskRepo} · ` : ''}{task.title}</span>
          </span>
        ) : null}
        {repo ? (
          <>
            <IconButton label="Fetch (f)" onClick={() => void startSync('fetch')} disabled={repoBusy}>
              <CloudDownload size={16} />
            </IconButton>
            <IconButton label="Pull" onClick={() => void startSync('pull')} disabled={repoBusy}>
              <RefreshCw size={16} />
            </IconButton>
            <IconButton label="Push…" onClick={onPush} disabled={repoBusy}>
              <CloudUpload size={16} />
            </IconButton>
          </>
        ) : null}
        <IconButton label="Git console (Ctrl/Cmd+J)" active={consoleOpen} onClick={() => toggleConsole()}>
          <SquareTerminal size={16} />
        </IconButton>
        <button className="palette-trigger" onClick={onPalette} title="Command palette (Ctrl/Cmd+K)">
          <Command size={14} />
          <span>Commands</span>
          <kbd>{window.commit87.platform === 'darwin' ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {!isMac ? (
          <div className="window-controls">
            <button aria-label="Minimize" onClick={() => void call('window.minimize', undefined)}>
              <Minus size={14} />
            </button>
            <button aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => void call('window.maximizeToggle', undefined).then(setMaximized)}>
              <Square size={11} />
            </button>
            <button aria-label="Close" className="close" onClick={() => void call('window.close', undefined)}>
              <X size={15} />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
