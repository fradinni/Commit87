import { useMemo, useState } from 'react'
import {
  FolderOpen,
  GitBranch,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
  Waypoints
} from 'lucide-react'
import type { WorktreeInfo } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { Badge, Button, Field, IconButton, Modal, Select, TextInput, EmptyState } from '../components/ui'

export function WorktreesView() {
  const repo = useStore((state) => state.currentRepo)
  const worktrees = useStore((state) => state.worktrees)
  const branches = useStore((state) => state.branches)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshWorktrees = useStore((state) => state.refreshWorktrees)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [mode, setMode] = useState<'existing' | 'new' | 'detached'>('new')
  const [branch, setBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [startPoint, setStartPoint] = useState('')
  const [target, setTarget] = useState('')
  const [removeTarget, setRemoveTarget] = useState<WorktreeInfo | null>(null)
  const [forceRemove, setForceRemove] = useState(false)

  const localBranches = useMemo(() => branches.filter((item) => item.type === 'branch'), [branches])

  if (!repo) return null

  const run = async (task: () => Promise<void>, message?: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      await refreshWorktrees()
      if (message) notify(message, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const create = (): void => {
    void run(async () => {
      await call('git.worktreeAdd', {
        repoPath: repo.path,
        path: target,
        branch: mode === 'new' ? newBranch.trim() : mode === 'detached' ? startPoint.trim() || 'HEAD' : branch,
        createBranch: mode === 'new',
        startPoint: mode === 'new' ? startPoint || undefined : mode === 'detached' ? startPoint || undefined : undefined,
        detach: mode === 'detached'
      })
      setAddOpen(false)
      setTarget('')
      setNewBranch('')
    }, 'Worktree created')
  }

  const remove = (): void => {
    if (!removeTarget) return
    void run(async () => {
      await call('git.worktreeRemove', {
        path: repo.path,
        worktreePath: removeTarget.path,
        force: forceRemove
      })
      setRemoveTarget(null)
      setForceRemove(false)
    }, 'Worktree removed')
  }

  const open = (path: string): void => {
    void useStore.getState().openRepo(path).catch(notifyError)
  }

  return (
    <div className="view worktrees-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Waypoints size={17} />
          <h2>Worktrees</h2>
          <Badge tone="neutral">{worktrees.length}</Badge>
        </div>
        <div className="toolbar-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refreshWorktrees()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<Unplug size={13} />}
            onClick={() => void run(async () => { await call('git.worktreePrune', { path: repo.path }) }, 'Pruned stale worktrees')}
          >
            Prune
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => { setMode('new'); setStartPoint(repo.currentBranch ?? ''); setAddOpen(true) }}>
            Add worktree
          </Button>
        </div>
      </div>

      {worktrees.length === 0 ? (
        <EmptyState
          icon={<Waypoints size={22} />}
          title="No worktrees"
          description="Worktrees let you check out multiple branches side by side in separate folders."
          action={<Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>Add the first worktree</Button>}
        />
      ) : (
        <div className="worktree-grid">
          {worktrees.map((worktree) => (
            <article className={`worktree-card ${worktree.isCurrent ? 'is-current' : ''}`} key={worktree.path}>
              <header className="worktree-head">
                <span className="worktree-icon">
                  <Waypoints size={16} />
                </span>
                <span className="worktree-branch">
                  <GitBranch size={13} />
                  {worktree.branch ?? (worktree.detached ? 'detached HEAD' : 'bare')}
                </span>
                {worktree.isMain ? <Badge tone="neutral">main</Badge> : <Badge tone="outline">linked</Badge>}
                {worktree.isCurrent ? <Badge tone="green">open</Badge> : null}
                {worktree.locked ? <Badge tone="amber">locked</Badge> : null}
                {worktree.prunable ? <Badge tone="red">prunable</Badge> : null}
              </header>
              <div className="worktree-path mono" title={worktree.path}>{worktree.path}</div>
              <div className="worktree-meta">
                <span>HEAD {worktree.head?.slice(0, 8) ?? '—'}</span>
                {worktree.lockReason ? <span>Lock: {worktree.lockReason}</span> : null}
              </div>
              <footer className="worktree-actions">
                <Button size="sm" variant={worktree.isCurrent ? 'ghost' : 'outline'} icon={<FolderOpen size={13} />} onClick={() => open(worktree.path)} disabled={worktree.isCurrent}>
                  {worktree.isCurrent ? 'Currently open' : 'Open'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={worktree.locked ? <LockOpen size={13} /> : <Lock size={13} />}
                  onClick={() =>
                    void run(async () => {
                      if (worktree.locked) await call('git.worktreeUnlock', { path: repo.path, worktreePath: worktree.path })
                      else await call('git.worktreeLock', { path: repo.path, worktreePath: worktree.path })
                    }, worktree.locked ? 'Worktree unlocked' : 'Worktree locked')
                  }
                >
                  {worktree.locked ? 'Unlock' : 'Lock'}
                </Button>
                <IconButton label="Show in file manager" onClick={() => void call('app.showItemInFolder', { path: worktree.path })}>
                  <FolderOpen size={14} />
                </IconButton>
                <IconButton
                  label="Remove worktree"
                  danger
                  disabled={worktree.isCurrent}
                  onClick={() => {
                    setRemoveTarget(worktree)
                    setForceRemove(Boolean(worktree.prunable))
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </footer>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={addOpen}
        title="Add worktree"
        subtitle="Check out a branch in a separate folder"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!target || (mode === 'existing' && !branch)} onClick={create}>Create worktree</Button>
          </>
        }
      >
        <Field label="Mode">
          <Select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="new">Create a new branch</option>
            <option value="existing">Use an existing branch</option>
            <option value="detached">Detached HEAD at a commit</option>
          </Select>
        </Field>
        {mode === 'new' ? (
          <>
            <Field label="New branch name">
              <TextInput value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="feature/worktree" autoFocus />
            </Field>
            <Field label="Start point">
              <Select value={startPoint} onChange={(event) => setStartPoint(event.target.value)}>
                <option value="">Current HEAD ({repo.currentBranch ?? 'detached'})</option>
                {localBranches.map((item) => (
                  <option key={item.name} value={item.shortName}>{item.shortName}</option>
                ))}
              </Select>
            </Field>
          </>
        ) : mode === 'existing' ? (
          <Field label="Branch">
            <Select value={branch} onChange={(event) => setBranch(event.target.value)}>
              <option value="">Select a branch…</option>
              {localBranches.map((item) => (
                <option key={item.name} value={item.shortName}>{item.shortName}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Commit or ref">
            <TextInput value={startPoint} onChange={(event) => setStartPoint(event.target.value)} placeholder="HEAD, a branch or a SHA" />
          </Field>
        )}
        <Field label="Folder" hint="Must be outside the repository root.">
          <div className="row-gap">
            <TextInput value={target} onChange={(event) => setTarget(event.target.value)} placeholder="/home/you/worktrees/feature" />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void call('app.pickDirectory', { title: 'Choose worktree folder' }).then((chosen) => {
                  if (chosen) setTarget(chosen)
                })
              }
            >
              Browse…
            </Button>
          </div>
        </Field>
      </Modal>

      <Modal
        open={Boolean(removeTarget)}
        title="Remove worktree"
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={remove}>Remove worktree</Button>
          </>
        }
      >
        <p className="confirm-message">
          Remove the worktree at <strong>{removeTarget?.path}</strong>? The branch itself is kept.
        </p>
        <label className="checkbox-row">
          <input type="checkbox" checked={forceRemove} onChange={(event) => setForceRemove(event.target.checked)} />
          Force removal (discards uncommitted changes in that worktree)
        </label>
      </Modal>
    </div>
  )
}
