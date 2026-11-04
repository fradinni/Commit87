import { AlertTriangle, GitBranch, GitCommitHorizontal, GitMerge, Play, RotateCcw, XCircle } from 'lucide-react'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { Button, Spinner } from './ui'

export function StatusBar() {
  const repo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const appInfo = useStore((state) => state.appInfo)
  const task = useStore((state) => state.task)
  const refreshRepo = useStore((state) => state.refreshRepo)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)

  const runOperation = async (action: 'continue' | 'abort'): Promise<void> => {
    if (!repo) return
    try {
      if (action === 'continue') {
        const result = await call('git.continueOperation', { path: repo.path })
        if (result.output) notify(result.output, 'info')
      } else {
        await call('git.abortOperation', { path: repo.path })
      }
      await useStore.getState().refreshAll()
      notify(action === 'continue' ? 'Operation continued' : 'Operation aborted', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  if (!repo) {
    return (
      <footer className="statusbar">
        <span className="status-left">
          <GitCommitHorizontal size={13} /> Ready
        </span>
        <span className="status-right">
          {appInfo?.git.available ? appInfo.git.version : 'git missing'} · {appInfo?.platform}/{appInfo?.arch}
        </span>
      </footer>
    )
  }

  const operation = repo.state !== 'clean'

  return (
    <footer className={`statusbar ${operation ? 'has-operation' : ''}`}>
      <span className="status-left">
        <GitBranch size={13} />
        <span>{status?.branch ?? (repo.detached ? 'detached HEAD' : 'no branch')}</span>
        {status?.upstream ? <span className="status-muted">→ {status.upstream}</span> : null}
        {status?.ahead ? <span className="status-ahead">↑{status.ahead}</span> : null}
        {status?.behind ? <span className="status-behind">↓{status.behind}</span> : null}
        {status && !status.clean ? (
          <span className="status-changes">
            {status.stagedCount ? `${status.stagedCount} staged` : ''}
            {status.stagedCount && status.unstagedCount ? ' · ' : ''}
            {status.unstagedCount ? `${status.unstagedCount} modified` : ''}
            {(status.stagedCount || status.unstagedCount) && status.untrackedCount ? ' · ' : ''}
            {status.untrackedCount ? `${status.untrackedCount} untracked` : ''}
            {status.conflictedCount ? ` · ${status.conflictedCount} conflicted` : ''}
          </span>
        ) : (
          <span className="status-muted">clean</span>
        )}
      </span>

      {operation ? (
        <div className="operation-banner">
          <AlertTriangle size={13} />
          <span>{operationLabel(repo.state)}</span>
          <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={() => void runOperation('continue')}>
            Continue
          </Button>
          <Button size="sm" variant="ghost" icon={<XCircle size={12} />} onClick={() => void runOperation('abort')}>
            Abort
          </Button>
        </div>
      ) : task ? (
        <div className="task-banner">
          <Spinner size={12} />
          <span>{task.title}</span>
        </div>
      ) : null}

      <span className="status-right">
        {status?.headSha ? <code>{status.headSha.slice(0, 8)}</code> : null}
        <span className="status-divider" />
        <span title={appInfo?.git.path}>{appInfo?.git.available ? appInfo.git.version.replace('git version ', 'git ') : 'git unavailable'}</span>
        <span className="status-divider" />
        <button className="status-refresh" onClick={() => void refreshRepo()} title="Refresh status">
          <RotateCcw size={12} />
        </button>
      </span>
    </footer>
  )
}

function operationLabel(state: string): string {
  switch (state) {
    case 'merging':
      return 'Merge in progress'
    case 'rebasing':
      return 'Rebase in progress'
    case 'cherry-picking':
      return 'Cherry-pick in progress'
    case 'reverting':
      return 'Revert in progress'
    case 'applying':
      return 'Patch apply in progress'
    case 'bisecting':
      return 'Bisect in progress'
    default:
      return 'Operation in progress'
  }
}

export function RepoOperationBanner() {
  const repo = useStore((state) => state.currentRepo)
  const notifyError = useStore((state) => state.notifyError)
  if (!repo || repo.state === 'clean') return null
  const abort = async (): Promise<void> => {
    try {
      await call('git.abortOperation', { path: repo.path })
      await useStore.getState().refreshAll()
    } catch (error) {
      notifyError(error)
    }
  }
  return (
    <div className="repo-operation-banner">
      <GitMerge size={15} />
      <span>{operationLabel(repo.state)}. Resolve conflicts, then continue or abort.</span>
      <Button size="sm" variant="ghost" onClick={() => void abort()}>
        Abort
      </Button>
    </div>
  )
}
