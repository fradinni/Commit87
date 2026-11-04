import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Waypoints
} from 'lucide-react'
import type { RefInfo } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { formatRelativeTime } from '../lib/format'
import { Badge, Button, ConfirmDialog, Field, IconButton, Modal, Select, TextInput } from '../components/ui'

export function BranchesView() {
  const repo = useStore((state) => state.currentRepo)
  const branches = useStore((state) => state.branches)
  const status = useStore((state) => state.status)
  const detection = useStore((state) => state.detection)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshBranches = useStore((state) => state.refreshBranches)
  const [filter, setFilter] = useState<'local' | 'remote' | 'all'>('local')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [startPoint, setStartPoint] = useState('')
  const [checkoutNew, setCheckoutNew] = useState(true)
  const [rename, setRename] = useState<RefInfo | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [del, setDel] = useState<RefInfo | null>(null)
  const [deleteRemote, setDeleteRemote] = useState('')
  const [forceDelete, setForceDelete] = useState(false)
  const [merge, setMerge] = useState<RefInfo | null>(null)
  const [mergeMode, setMergeMode] = useState<'default' | 'no-ff' | 'ff-only' | 'squash'>('default')
  const [worktreeFor, setWorktreeFor] = useState<RefInfo | null>(null)
  const [worktreePath, setWorktreePath] = useState('')
  const [confirmRebase, setConfirmRebase] = useState<RefInfo | null>(null)

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return branches.filter((branch) => {
      if (filter === 'local' && branch.type !== 'branch') return false
      if (filter === 'remote' && branch.type !== 'remote') return false
      if (!term) return true
      return `${branch.shortName} ${branch.subject ?? ''} ${branch.author ?? ''}`.toLowerCase().includes(term)
    })
  }, [branches, filter, query])

  if (!repo) return null

  const run = async (task: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      await useStore.getState().refreshAll()
      if (success) notify(success, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const checkout = (branch: RefInfo): void => {
    if (branch.isCurrent) return
    if (branch.type === 'remote') {
      const localName = branch.shortName.split('/').slice(1).join('/')
      void run(async () => {
        await call('git.checkout', {
          repoPath: repo.path,
          branch: localName,
          create: true,
          startPoint: branch.shortName,
          track: true
        })
      }, `Checked out ${localName}`)
      return
    }
    void run(async () => {
      await call('git.checkout', { repoPath: repo.path, branch: branch.shortName })
    }, `Checked out ${branch.shortName}`)
  }

  const create = (): void => {
    if (!newName.trim()) return
    void run(async () => {
      await call('git.createBranch', {
        path: repo.path,
        name: newName.trim(),
        startPoint: startPoint || undefined,
        checkout: checkoutNew,
        track: Boolean(startPoint.startsWith('origin/') || startPoint.split('/').length > 1)
      })
      setCreateOpen(false)
      setNewName('')
      setStartPoint('')
    }, `Branch ${newName.trim()} created`)
  }

  const doRename = (): void => {
    if (!rename || !renameValue.trim()) return
    void run(async () => {
      await call('git.renameBranch', { path: repo.path, from: rename.shortName, to: renameValue.trim() })
      setRename(null)
      setRenameValue('')
    }, 'Branch renamed')
  }

  const doDelete = (): void => {
    if (!del) return
    void run(async () => {
      await call('git.deleteBranch', {
        path: repo.path,
        name: del.shortName,
        force: forceDelete,
        remote: deleteRemote || undefined,
        identityId: activeIdentity()?.id,
        accountId: detection.accountId
      })
      setDel(null)
    }, 'Branch deleted')
  }

  const doMerge = (): void => {
    if (!merge) return
    void run(async () => {
      const result = await call('git.merge', {
        repoPath: repo.path,
        branch: merge.shortName,
        noFf: mergeMode === 'no-ff' || mergeMode === 'default',
        ffOnly: mergeMode === 'ff-only',
        squash: mergeMode === 'squash',
        identityId: activeIdentity()?.id
      })
      if (result.output.trim()) notify(result.output.trim().slice(0, 600), 'info')
      setMerge(null)
    }, `Merged ${merge.shortName}`)
  }

  const doRebase = (): void => {
    if (!confirmRebase) return
    void run(async () => {
      const result = await call('git.rebase', {
        path: repo.path,
        onto: confirmRebase.shortName,
        identityId: activeIdentity()?.id
      })
      if (result.output.trim()) notify(result.output.trim().slice(0, 600), 'info')
      setConfirmRebase(null)
    }, `Rebased onto ${confirmRebase.shortName}`)
  }

  const addWorktree = (): void => {
    if (!worktreeFor || !worktreePath) return
    void run(async () => {
      const localBranch = worktreeFor.shortName.split('/').slice(1).join('/') || worktreeFor.shortName
      await call('git.worktreeAdd', {
        repoPath: repo.path,
        path: worktreePath,
        branch: worktreeFor.type === 'remote' ? localBranch : worktreeFor.shortName,
        createBranch: worktreeFor.type === 'remote',
        startPoint: worktreeFor.type === 'remote' ? worktreeFor.shortName : undefined
      })
      setWorktreeFor(null)
      setWorktreePath('')
    }, 'Worktree created')
  }

  return (
    <div className="view branches-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <GitBranch size={17} />
          <h2>Branches</h2>
          <Badge tone="neutral">{branches.filter((branch) => branch.type === 'branch').length} local</Badge>
          <Badge tone="outline">{branches.filter((branch) => branch.type === 'remote').length} remote</Badge>
        </div>
        <div className="toolbar-actions">
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter branches…" spellCheck={false} />
          </div>
          <div className="segmented small">
            {(['local', 'remote', 'all'] as const).map((value) => (
              <button key={value} className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>
                {value}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refreshBranches()}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => { setStartPoint(status?.branch ?? ''); setCreateOpen(true) }}>
            New branch
          </Button>
        </div>
      </div>

      <div className="table-wrap">
        <div className="data-table branch-table">
          <div className="data-head">
            <span>Branch</span>
            <span>Upstream</span>
            <span>Status</span>
            <span>Last commit</span>
            <span>Author</span>
            <span>Updated</span>
            <span />
          </div>
          {visible.map((branch) => (
            <div
              className={`data-row ${branch.isCurrent ? 'is-current' : ''}`}
              key={branch.name}
              onDoubleClick={() => checkout(branch)}
              title={branch.name}
            >
              <span className="cell-main">
                {branch.isCurrent ? <Check size={13} className="current-check" /> : branch.type === 'remote' ? <GitPullRequestArrow size={13} /> : <GitBranch size={13} />}
                <span className="mono ellipsis">{branch.type === 'remote' ? branch.shortName : branch.shortName}</span>
                {branch.isCurrent ? <Badge tone="green">current</Badge> : null}
                {branch.type === 'remote' ? <Badge tone="blue">remote</Badge> : null}
              </span>
              <span className="cell-muted ellipsis">{branch.upstream || '—'}</span>
              <span className="cell-track">
                {branch.ahead ? <span className="ahead"><ArrowUp size={11} />{branch.ahead}</span> : null}
                {branch.behind ? <span className="behind"><ArrowDown size={11} />{branch.behind}</span> : null}
                {!branch.ahead && !branch.behind ? <span className="cell-muted">—</span> : null}
              </span>
              <span className="cell-subject ellipsis">{branch.subject || '—'}</span>
              <span className="cell-muted ellipsis">{branch.author || '—'}</span>
              <span className="cell-muted">{formatRelativeTime(branch.date)}</span>
              <span className="cell-actions">
                {!branch.isCurrent ? (
                  <Button size="sm" variant="ghost" onClick={() => checkout(branch)}>
                    Checkout
                  </Button>
                ) : null}
                {branch.type === 'branch' ? (
                  <>
                    <IconButton label="Merge into current branch" onClick={() => setMerge(branch)}>
                      <GitMerge size={14} />
                    </IconButton>
                    <IconButton label="Rebase current branch onto this" onClick={() => setConfirmRebase(branch)}>
                      <ArrowUpRight size={14} />
                    </IconButton>
                    <IconButton label="Add worktree" onClick={() => { setWorktreeFor(branch); setWorktreePath('') }}>
                      <Waypoints size={14} />
                    </IconButton>
                    <IconButton label="Rename" onClick={() => { setRename(branch); setRenameValue(branch.shortName) }}>
                      <MoreHorizontal size={14} />
                    </IconButton>
                    <IconButton label="Delete" danger onClick={() => { setDel(branch); setForceDelete(false); setDeleteRemote('') }}>
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                ) : null}
              </span>
            </div>
          ))}
          {visible.length === 0 ? <div className="table-empty">No branches match this filter.</div> : null}
        </div>
      </div>

      <Modal
        open={createOpen}
        title="Create branch"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create}>Create</Button>
          </>
        }
      >
        <Field label="Branch name">
          <TextInput value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="feature/my-branch" autoFocus />
        </Field>
        <Field label="Start point">
          <Select value={startPoint} onChange={(event) => setStartPoint(event.target.value)}>
            <option value="">HEAD ({status?.branch ?? 'detached'})</option>
            {branches.map((branch) => (
              <option key={branch.name} value={branch.shortName}>
                {branch.shortName}
                {branch.type === 'remote' ? ' (remote)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <label className="checkbox-row">
          <input type="checkbox" checked={checkoutNew} onChange={(event) => setCheckoutNew(event.target.checked)} />
          Check out the new branch
        </label>
      </Modal>

      <Modal
        open={Boolean(rename)}
        title="Rename branch"
        onClose={() => setRename(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={doRename}>Rename</Button>
          </>
        }
      >
        <Field label="New name">
          <TextInput value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
        </Field>
      </Modal>

      <Modal
        open={Boolean(del)}
        title={`Delete ${del?.shortName ?? ''}`}
        onClose={() => setDel(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={doDelete}>Delete branch</Button>
          </>
        }
      >
        <p className="confirm-message">This removes the local branch. Unmerged commits would be lost when force deleting.</p>
        <label className="checkbox-row">
          <input type="checkbox" checked={forceDelete} onChange={(event) => setForceDelete(event.target.checked)} />
          Force delete (discard unmerged commits)
        </label>
        <Field label="Also delete on remote" hint="Requires a configured integration token to authenticate.">
          <Select value={deleteRemote} onChange={(event) => setDeleteRemote(event.target.value)}>
            <option value="">Do not delete on remote</option>
            {repo.remotes.map((remote) => (
              <option key={remote.name} value={remote.name}>{remote.name}</option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={Boolean(merge)}
        title={`Merge ${merge?.shortName ?? ''}`}
        onClose={() => setMerge(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMerge(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={doMerge}>Merge</Button>
          </>
        }
      >
        <Field label="Strategy">
          <Select value={mergeMode} onChange={(event) => setMergeMode(event.target.value as typeof mergeMode)}>
            <option value="default">Create merge commit (--no-ff)</option>
            <option value="no-ff">Always merge commit (--no-ff)</option>
            <option value="ff-only">Fast-forward only</option>
            <option value="squash">Squash</option>
          </Select>
        </Field>
        <p className="muted">
          Merging into {status?.branch ?? 'the current branch'} with identity {activeIdentity()?.email ?? '(none)'}.
        </p>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmRebase)}
        title={`Rebase onto ${confirmRebase?.shortName ?? ''}?`}
        message={`Replays ${status?.branch ?? 'the current branch'} commits on top of ${confirmRebase?.shortName}. Conflicts can be resolved from the status bar.`}
        confirmLabel="Rebase"
        busy={busy}
        onCancel={() => setConfirmRebase(null)}
        onConfirm={doRebase}
      />

      <Modal
        open={Boolean(worktreeFor)}
        title={`Worktree from ${worktreeFor?.shortName ?? ''}`}
        onClose={() => setWorktreeFor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setWorktreeFor(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={addWorktree}>Create worktree</Button>
          </>
        }
      >
        <Field label="Worktree folder" hint="The folder must be outside the main repository.">
          <div className="row-gap">
            <TextInput value={worktreePath} onChange={(event) => setWorktreePath(event.target.value)} placeholder="/home/you/worktrees/feature" />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void call('app.pickDirectory', { title: 'Choose worktree folder' }).then((chosen) => {
                  if (chosen) setWorktreePath(chosen)
                })
              }
            >
              Browse…
            </Button>
          </div>
        </Field>
        {worktreeFor?.type === 'remote' ? (
          <p className="muted">A new local branch will be created from {worktreeFor.shortName}.</p>
        ) : null}
      </Modal>
    </div>
  )
}
