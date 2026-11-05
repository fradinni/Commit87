import { useState } from 'react'
import {
  Boxes,
  CloudDownload,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import type { SubmoduleInfo, SubmoduleState } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { Badge, Button, EmptyState, Field, IconButton, Modal, TextInput } from '../components/ui'

const STATE_TONE: Record<SubmoduleState, 'neutral' | 'green' | 'amber' | 'red'> = {
  initialized: 'green',
  uninitialized: 'neutral',
  modified: 'amber',
  conflicted: 'red'
}

const STATE_LABEL: Record<SubmoduleState, string> = {
  initialized: 'up to date',
  uninitialized: 'not initialized',
  modified: 'out of sync',
  conflicted: 'conflict'
}

export function SubmodulesView() {
  const repo = useStore((state) => state.currentRepo)
  const submodules = useStore((state) => state.submodules)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshSubmodules = useStore((state) => state.refreshSubmodules)
  const refreshStatus = useStore((state) => state.refreshStatus)
  const openRepo = useStore((state) => state.openRepo)
  const [busy, setBusy] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [branch, setBranch] = useState('')
  const [removeTarget, setRemoveTarget] = useState<SubmoduleInfo | null>(null)
  const [forceRemove, setForceRemove] = useState(false)
  const [forceTarget, setForceTarget] = useState<SubmoduleInfo | null>(null)

  if (!repo) return null

  const run = async (key: string, task: () => Promise<void>, message?: string): Promise<void> => {
    setBusy(key)
    try {
      await task()
      await refreshSubmodules(repo.path)
      await refreshStatus(repo.path)
      if (message) notify(message, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(null)
    }
  }

  const update = (submodule?: SubmoduleInfo, remote = false): void => {
    const key = `${remote ? 'remote' : 'update'}:${submodule?.path ?? 'all'}`
    void run(
      key,
      async () => {
        await call('git.submoduleUpdate', {
          repoPath: repo.path,
          submodulePath: submodule?.path,
          init: true,
          recursive: true,
          remote
        })
      },
      remote ? 'Submodule updated to the tracked branch' : submodule ? 'Submodule updated' : 'All submodules updated'
    )
  }

  const sync = (submodule?: SubmoduleInfo): void => {
    void run(
      `sync:${submodule?.path ?? 'all'}`,
      async () => {
        await call('git.submoduleSync', {
          repoPath: repo.path,
          submodulePath: submodule?.path,
          recursive: true
        })
      },
      submodule ? 'Submodule URL synced' : 'Submodule URLs synced'
    )
  }

  const add = (): void => {
    void run(
      'add',
      async () => {
        await call('git.submoduleAdd', {
          repoPath: repo.path,
          url: url.trim(),
          path: targetPath.trim() || undefined,
          branch: branch.trim() || undefined
        })
        setAddOpen(false)
        setUrl('')
        setTargetPath('')
        setBranch('')
      },
      'Submodule added'
    )
  }

  const remove = (): void => {
    if (!removeTarget) return
    void run(
      'remove',
      async () => {
        await call('git.submoduleRemove', {
          repoPath: repo.path,
          submodulePath: removeTarget.path,
          force: forceRemove
        })
        setRemoveTarget(null)
        setForceRemove(false)
      },
      'Submodule removed — the change is staged'
    )
  }

  const resetDirty = (): void => {
    if (!forceTarget) return
    void run(
      `update:${forceTarget.path}`,
      async () => {
        await call('git.submoduleUpdate', {
          repoPath: repo.path,
          submodulePath: forceTarget.path,
          init: true,
          recursive: true,
          force: true,
          clean: true
        })
        setForceTarget(null)
      },
      'Submodule reset to the recorded commit'
    )
  }

  const open = (submodule: SubmoduleInfo): void => {
    void openRepo(`${repo.path.replace(/[\\/]+$/, '')}/${submodule.path}`).catch(notifyError)
  }

  const showInFolder = (submodule: SubmoduleInfo): void => {
    void call('app.showItemInFolder', {
      path: `${repo.path.replace(/[\\/]+$/, '')}/${submodule.path}`
    }).catch(notifyError)
  }

  const outdated = submodules.filter(
    (submodule) => !submodule.initialized || submodule.modified || submodule.conflicted || submodule.dirty
  ).length
  const locked = busy !== null

  return (
    <div className="view submodules-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Boxes size={17} />
          <h2>Submodules</h2>
          <Badge tone="neutral">{submodules.length}</Badge>
          {outdated > 0 ? <Badge tone="amber">{outdated} need attention</Badge> : null}
        </div>
        <div className="toolbar-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={locked} onClick={() => void refreshSubmodules()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<RefreshCw size={13} />}
            loading={busy === 'sync:all'}
            disabled={locked || submodules.length === 0}
            onClick={() => sync()}
          >
            Sync URLs
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<CloudDownload size={13} />}
            loading={busy === 'update:all'}
            disabled={locked || submodules.length === 0}
            onClick={() => update()}
          >
            Update all
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            disabled={locked || repo.isBare}
            onClick={() => setAddOpen(true)}
          >
            Add submodule
          </Button>
        </div>
      </div>

      {submodules.length === 0 ? (
        <EmptyState
          icon={<Boxes size={22} />}
          title="No submodules"
          description="Submodules embed another Git repository at a pinned commit. Add one to clone it and keep its URL under version control."
          action={<Button variant="primary" size="sm" disabled={repo.isBare} onClick={() => setAddOpen(true)}>Add the first submodule</Button>}
        />
      ) : (
        <div className="submodule-grid">
          {submodules.map((submodule) => {
            const rowBusy = locked
            return (
              <article
                className={`submodule-card ${submodule.state === 'conflicted' ? 'is-conflicted' : ''}`}
                key={submodule.path}
                aria-label={`Submodule ${submodule.path}`}
              >
                <header className="submodule-head">
                  <span className="submodule-icon">
                    <Boxes size={15} />
                  </span>
                  <span className="submodule-path" title={submodule.path}>{submodule.path}</span>
                  <Badge tone={STATE_TONE[submodule.state]}>{STATE_LABEL[submodule.state]}</Badge>
                  {submodule.branch ? (
                    <Badge tone="outline">
                      <GitBranch size={10} /> {submodule.branch}
                    </Badge>
                  ) : null}
                  {submodule.dirty ? <Badge tone="amber">local changes</Badge> : null}
                </header>
                <div className="submodule-url mono" title={submodule.url}>
                  {submodule.url || 'No URL recorded in .gitmodules'}
                </div>
                <div className="submodule-meta">
                  <span>
                    HEAD {submodule.initialized ? submodule.shortSha : `— (recorded ${submodule.shortSha})`}
                  </span>
                  {submodule.describe ? <span>{submodule.describe}</span> : null}
                </div>
                <footer className="submodule-actions">
                  <Button
                    size="sm"
                    variant={submodule.initialized ? 'outline' : 'primary'}
                    icon={<CloudDownload size={13} />}
                    loading={busy === `update:${submodule.path}`}
                    disabled={rowBusy}
                    onClick={() => update(submodule)}
                  >
                    {submodule.initialized ? 'Update' : 'Initialize'}
                  </Button>
                  {submodule.branch ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<GitBranch size={13} />}
                      loading={busy === `remote:${submodule.path}`}
                      disabled={rowBusy}
                      onClick={() => update(submodule, true)}
                    >
                      Latest
                    </Button>
                  ) : null}
                  {submodule.dirty ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RotateCcw size={13} />}
                      disabled={rowBusy}
                      onClick={() => setForceTarget(submodule)}
                    >
                      Reset
                    </Button>
                  ) : null}
                  <IconButton
                    label="Re-sync submodule URL"
                    disabled={rowBusy}
                    onClick={() => sync(submodule)}
                  >
                    <RefreshCw size={14} />
                  </IconButton>
                  <IconButton
                    label="Open submodule repository"
                    disabled={!submodule.initialized || rowBusy}
                    onClick={() => open(submodule)}
                  >
                    <FolderGit2 size={14} />
                  </IconButton>
                  <IconButton label="Show in file manager" disabled={rowBusy} onClick={() => showInFolder(submodule)}>
                    <FolderOpen size={14} />
                  </IconButton>
                  <IconButton
                    label="Remove submodule"
                    danger
                    disabled={rowBusy}
                    onClick={() => {
                      setRemoveTarget(submodule)
                      setForceRemove(false)
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </footer>
              </article>
            )
          })}
        </div>
      )}

      <Modal
        open={addOpen}
        title="Add submodule"
        subtitle="Clones another repository and records the pinned commit in this repository."
        onClose={() => setAddOpen(false)}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'add'} disabled={!url.trim()} onClick={add}>
              Add submodule
            </Button>
          </>
        }
      >
        <Field label="Repository URL" hint="HTTPS or SSH URL. Local paths depend on Git's protocol.file.allow setting.">
          <TextInput
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/library.git"
            autoFocus
          />
        </Field>
        <Field label="Path" hint="Optional. Defaults to the repository name and must stay inside this repository.">
          <TextInput
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
            placeholder="vendor/library"
          />
        </Field>
        <Field label="Track branch" hint="Optional. Enables Update to latest from that branch.">
          <TextInput
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
          />
        </Field>
      </Modal>

      <Modal
        open={Boolean(removeTarget)}
        title="Remove submodule"
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={busy === 'remove'} onClick={remove}>Remove submodule</Button>
          </>
        }
      >
        <p className="confirm-message">
          Remove <strong>{removeTarget?.path}</strong> from this repository? The working tree and the
          <span className="mono"> .gitmodules</span> entry are removed and the change is staged. The submodule's
          remote repository is not touched, but the local module clone is deleted.
        </p>
        <label className="checkbox-row">
          <input type="checkbox" checked={forceRemove} onChange={(event) => setForceRemove(event.target.checked)} />
          Force removal, discarding uncommitted changes and local commits that were never pushed
        </label>
      </Modal>

      <Modal
        open={Boolean(forceTarget)}
        title="Reset submodule"
        onClose={() => setForceTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForceTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={busy === `update:${forceTarget?.path}`} onClick={resetDirty}>
              Discard and reset
            </Button>
          </>
        }
      >
        <p className="confirm-message">
          Discard the uncommitted changes, including untracked files, inside <strong>{forceTarget?.path}</strong> and
          check out the commit recorded by this repository?
        </p>
      </Modal>
    </div>
  )
}