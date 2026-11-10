import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Play,
  RotateCcw,
  SkipForward,
  XCircle
} from 'lucide-react'
import { operationNotice, useStore } from '../store'
import { call } from '../lib/ipc'
import { Button, Spinner } from './ui'

type OperationAction = 'continue' | 'skip' | 'abort'

/** Continue, skip and abort share one truthful path: refresh, then report. */
async function runOperation(repoPath: string, action: OperationAction): Promise<void> {
  try {
    if (action === 'abort') {
      await call('git.abortOperation', { path: repoPath })
      await useStore.getState().refreshAll(repoPath)
      useStore.getState().notify('Operation aborted', 'success')
      return
    }
    const result =
      action === 'continue'
        ? await call('git.continueOperation', { path: repoPath })
        : await call('git.skipOperation', { path: repoPath })
    // Refresh even when the operation paused or failed: a partial merge or
    // rebase leaves real changes that the tabs must show.
    await useStore.getState().refreshAll(repoPath)
    const notice = operationNotice(
      result,
      action === 'continue' ? 'Operation continued' : 'Commit skipped',
      action === 'continue' ? 'Continue' : 'Skip'
    )
    useStore.getState().notify(notice.message, notice.kind)
  } catch (error) {
    useStore.getState().notifyError(error)
  }
}

function canSkip(state: string): boolean {
  return state === 'rebasing' || state === 'cherry-picking' || state === 'reverting' || state === 'applying'
}

export function StatusBar() {
  const repo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const appInfo = useStore((state) => state.appInfo)
  const task = useStore((state) => state.task)
  const refreshRepo = useStore((state) => state.refreshRepo)

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
        <span>{status?.branch ?? repo.currentBranch ?? (repo.detached ? 'detached HEAD' : 'no branch')}</span>
        {repo.isBare ? (
          <span className="status-muted">bare repository · no working tree</span>
        ) : (
          <>
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
          </>
        )}
      </span>

      {operation ? (
        <div className="operation-banner">
          <AlertTriangle size={13} />
          <span>{operationLabel(repo.state)}</span>
          {repo.state !== 'bisecting' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Play size={12} />}
              onClick={() => void runOperation(repo.path, 'continue')}
            >
              Continue
            </Button>
          ) : null}
          {canSkip(repo.state) ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<SkipForward size={12} />}
              onClick={() => void runOperation(repo.path, 'skip')}
            >
              Skip
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<XCircle size={12} />}
            onClick={() => void runOperation(repo.path, 'abort')}
          >
            Abort
          </Button>
        </div>
      ) : task ? (
        <div className="task-banner">
          <Spinner size={12} />
          <span>{task.repoPath ? `${task.repoPath.split(/[\\/]/).filter(Boolean).pop()} · ` : ''}{task.title}</span>
        </div>
      ) : null}

      <span className="status-right">
        {(status?.headSha ?? repo.headSha) ? <code>{(status?.headSha ?? repo.headSha ?? '').slice(0, 8)}</code> : null}
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
  if (!repo) return null
  if (repo.isBare) {
    return (
      <div className="repo-operation-banner">
        <GitMerge size={15} />
        <span>
          Bare repository: there is no working tree. History, branches, tags and remotes stay available; status, staging and
          working-tree diffs do not apply.
        </span>
      </div>
    )
  }
  if (repo.state === 'clean') return null
  return (
    <div className="repo-operation-banner">
      <GitMerge size={15} />
      <span>{operationLabel(repo.state)}. Resolve conflicts, then continue or abort.</span>
      {repo.state !== 'bisecting' ? (
        <Button size="sm" variant="ghost" onClick={() => void runOperation(repo.path, 'continue')}>
          Continue
        </Button>
      ) : null}
      {canSkip(repo.state) ? (
        <Button size="sm" variant="ghost" onClick={() => void runOperation(repo.path, 'skip')}>
          Skip
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void runOperation(repo.path, 'abort')}>
        Abort
      </Button>
    </div>
  )
}
