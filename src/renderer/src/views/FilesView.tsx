import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileWarning,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Undo2,
  UserRound
} from 'lucide-react'
import type { BlameLine, DiffResult, DirEntry, FileContent, StatusFile } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { formatRelativeTime, languageFromPath } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, LoadingBlock, Select, TextArea } from '../components/ui'
import { DiffView } from '../components/DiffView'
import { IdentitySelect } from '../components/selectors'

// highlight.js is the largest renderer dependency. Load it only when a file is
// actually opened instead of parsing it during the first paint of the graph.
const CodeView = lazy(() => import('../components/CodeView').then((module) => ({ default: module.CodeView })))

type FilesTab = 'changes' | 'browse'

export function FilesView() {
  const repo = useStore((state) => state.currentRepo)
  const repoPath = repo?.path ?? ''
  const status = useStore((state) => state.status)
  const repoDefaults = useStore((state) => state.repoDefaults)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshAll = useStore((state) => state.refreshAll)
  const refreshStatus = useStore((state) => state.refreshStatus)

  const [tab, setTab] = useState<FilesTab>('changes')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [signoff, setSignoff] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<StatusFile[] | null>(null)
  const [identityId, setIdentityId] = useState<string | undefined>(repoDefaults.identityId)
  const identity = useStore((state) => state.identityById(identityId)) ?? activeIdentity()
  const [browseFrom, setBrowseFrom] = useState<'worktree' | 'head'>('worktree')
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [blame, setBlame] = useState<BlameLine[] | null>(null)
  const [blameLoading, setBlameLoading] = useState(false)
  const [tree, setTree] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeLoading, setTreeLoading] = useState(false)
  const [browseFile, setBrowseFile] = useState<string | null>(null)

  useEffect(() => {
    setIdentityId(repoDefaults.identityId)
  }, [repoDefaults.identityId, repo?.path])

  const selectedStatus = useMemo(
    () => status?.files.find((file) => file.path === selectedFile) ?? null,
    [selectedFile, status]
  )

  const loadDiff = useCallback(
    async (file: StatusFile) => {
      if (!repoPath) return
      setDiffLoading(true)
      setDiff(null)
      try {
        const result = await call('git.diff', {
          repoPath,
          path: file.path,
          staged: file.stage === 'staged'
        })
        setDiff(result)
        if (file.stage === 'untracked') {
          const content = await call('git.fileContent', { path: repoPath, file: file.path, from: 'worktree' })
          setFileContent(content)
        }
      } catch (error) {
        notifyError(error)
      } finally {
        setDiffLoading(false)
      }
    },
    [notifyError, repoPath]
  )

  const selectedStage = selectedStatus?.stage
  useEffect(() => {
    if (!selectedFile) return
    const file = useStore.getState().status?.files.find((item) => item.path === selectedFile)
    if (file) void loadDiff(file)
    else {
      setDiff(null)
      setFileContent(null)
    }
  }, [loadDiff, selectedFile, selectedStage])

  const loadTree = useCallback(
    async (dir = '') => {
      if (!repoPath) return
      setTreeLoading(true)
      try {
        const entries = await call('git.fileTree', { path: repoPath, dir })
        setTree((current) => ({ ...current, [dir]: entries }))
      } catch (error) {
        notifyError(error)
      } finally {
        setTreeLoading(false)
      }
    },
    [notifyError, repoPath]
  )

  useEffect(() => {
    if (!repoPath) return
    setTree({})
    setExpanded(new Set())
    setBrowseFile(null)
    setFileContent(null)
    setBlame(null)
    setSelectedFile(null)
    setDiff(null)
    if (tab === 'browse') void loadTree('')
  }, [repoPath, tab, loadTree])

  const loadFile = useCallback(
    async (file: string) => {
      if (!repoPath) return
      setBrowseFile(file)
      setBlame(null)
      setContentLoading(true)
      try {
        const content = await call('git.fileContent', {
          path: repoPath,
          file,
          from: browseFrom,
          commit: browseFrom === 'head' ? 'HEAD' : undefined
        })
        setFileContent(content)
      } catch (error) {
        notifyError(error)
      } finally {
        setContentLoading(false)
      }
    },
    [browseFrom, notifyError, repoPath]
  )

  useEffect(() => {
    if (browseFile && tab === 'browse' && !blame) void loadFile(browseFile)
  }, [browseFrom, browseFile, tab, blame, loadFile])

  const loadBlame = async (): Promise<void> => {
    if (!repo || !browseFile) return
    setBlameLoading(true)
    try {
      const lines = await call('git.blame', { path: repo.path, file: browseFile })
      setBlame(lines)
    } catch (error) {
      notifyError(error)
    } finally {
      setBlameLoading(false)
    }
  }

  if (!repo || !status) return null

  const groups: Array<{ key: string; label: string; files: StatusFile[]; tone: 'green' | 'blue' | 'amber' | 'red' }> = [
    { key: 'staged', label: 'Staged', files: status.files.filter((file) => file.stage === 'staged'), tone: 'green' as const },
    { key: 'unstaged', label: 'Changes', files: status.files.filter((file) => file.stage === 'unstaged'), tone: 'blue' as const },
    { key: 'untracked', label: 'Untracked', files: status.files.filter((file) => file.stage === 'untracked'), tone: 'amber' as const },
    { key: 'conflicted', label: 'Conflicts', files: status.files.filter((file) => file.stage === 'conflicted'), tone: 'red' as const }
  ].filter((group) => group.files.length > 0)
  const stageFiles = async (files: string[]): Promise<void> => {
    try {
      await call('git.stage', { path: repo.path, files })
      await refreshStatus()
      await useStore.getState().refreshBranches()
    } catch (error) {
      notifyError(error)
    }
  }

  const unstageFiles = async (files: string[]): Promise<void> => {
    try {
      await call('git.unstage', { path: repo.path, files })
      await refreshStatus()
    } catch (error) {
      notifyError(error)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    try {
      await call('git.discard', {
        path: repo.path,
        files: discardTarget.map((file) => file.path),
        includeUntracked: discardTarget.some((file) => file.stage === 'untracked')
      })
      setDiscardTarget(null)
      setSelectedFile(null)
      setDiff(null)
      await refreshAll()
      notify('Changes discarded', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  const commit = async (): Promise<void> => {
    if (!message.trim()) {
      notify('Write a commit message first', 'info')
      return
    }
    setCommitting(true)
    try {
      await call('git.commit', {
        repoPath: repo.path,
        message,
        amend,
        signoff,
        identityId: identity?.id
      })
      setMessage('')
      setAmend(false)
      setSelectedFile(null)
      setDiff(null)
      setFileContent(null)
      await refreshAll()
      notify('Commit created', 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setCommitting(false)
    }
  }

  const selectFile = (file: StatusFile): void => {
    setSelectedFile(file.path)
    setFileContent(null)
  }

  const saveIdentity = async (value: string | undefined): Promise<void> => {
    setIdentityId(value)
    try {
      const defaults = await call('repo.setDefaults', {
        path: repo.path,
        defaults: { ...repoDefaults, identityId: value }
      })
      useStore.setState({ repoDefaults: defaults })
      await useStore.getState().refreshConfig()
    } catch (error) {
      notifyError(error)
    }
  }

  const toggleDir = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!tree[path]) void loadTree(path)
    }
    setExpanded(next)
  }

  const renderTree = (dir: string, depth: number): React.ReactNode => {
    const entries = tree[dir] ?? []
    return entries.map((entry) => {
      if (entry.type === 'directory') {
        const isOpen = expanded.has(entry.path)
        return (
          <div key={entry.path}>
            <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggleDir(entry.path)}>
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {isOpen ? <FolderOpen size={14} className="tree-folder" /> : <Folder size={14} className="tree-folder" />}
              <span>{entry.name}</span>
            </button>
            {isOpen ? renderTree(entry.path, depth + 1) : null}
          </div>
        )
      }
      return (
        <button
          key={entry.path}
          className={`tree-row is-file ${browseFile === entry.path ? 'is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 + 16 }}
          onClick={() => void loadFile(entry.path)}
        >
          <FileCode2 size={13} />
          <span>{entry.name}</span>
        </button>
      )
    })
  }

  return (
    <div className="view files-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <div className="segmented">
            <button className={tab === 'changes' ? 'is-active' : ''} onClick={() => setTab('changes')}>
              <ListTree size={14} /> Changes
              {status.files.length ? <span className="seg-count">{status.files.length}</span> : null}
            </button>
            <button className={tab === 'browse' ? 'is-active' : ''} onClick={() => setTab('browse')}>
              <FolderOpen size={14} /> Browse code
            </button>
          </div>
        </div>
        <div className="toolbar-actions">
          {tab === 'changes' ? (
            <>
              <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => void stageFiles(status.files.map((file) => file.path))} disabled={!status.files.length}>
                Stage all
              </Button>
              <Button size="sm" variant="ghost" icon={<Minus size={13} />} onClick={() => void unstageFiles(status.files.filter((file) => file.stage === 'staged').map((file) => file.path))} disabled={!status.stagedCount}>
                Unstage all
              </Button>
              <Button size="sm" variant="outline" icon={<RotateCcw size={13} />} onClick={() => void refreshAll()}>
                Refresh
              </Button>
            </>
          ) : (
            <>
              <Select value={browseFrom} onChange={(event) => setBrowseFrom(event.target.value as typeof browseFrom)} className="compact-select">
                <option value="worktree">Working tree</option>
                <option value="head">HEAD</option>
              </Select>
              <Button size="sm" variant="ghost" icon={<UserRound size={13} />} onClick={() => void loadBlame()} disabled={!browseFile} loading={blameLoading}>
                Blame
              </Button>
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void loadTree('')} loading={treeLoading}>
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {tab === 'changes' ? (
        <div className="files-layout">
          <aside className="staging-panel">
            <div className="staging-scroll">
              {groups.length === 0 ? (
                <EmptyState icon={<GitCommitHorizontal size={20} />} title="Working tree clean" description="No staged, modified or untracked files." />
              ) : (
                groups.map((group) => (
                  <section className="change-group" key={group.key}>
                    <header className="change-group-head">
                      <span>
                        <Badge tone={group.tone}>{group.label}</Badge>
                        <span className="change-count">{group.files.length}</span>
                      </span>
                      <span className="change-group-actions">
                        {group.key === 'staged' ? (
                          <IconButton label="Unstage all" onClick={() => void unstageFiles(group.files.map((file) => file.path))}>
                            <Minus size={13} />
                          </IconButton>
                        ) : (
                          <IconButton label="Stage all" onClick={() => void stageFiles(group.files.map((file) => file.path))}>
                            <Plus size={13} />
                          </IconButton>
                        )}
                      </span>
                    </header>
                    {group.files.map((file) => (
                      <div
                        key={`${group.key}-${file.path}`}
                        className={`change-row ${selectedFile === file.path ? 'is-active' : ''}`}
                        onClick={() => selectFile(file)}
                      >
                        <span className={`change-status change-${file.index === '.' ? file.worktree : file.index}`}>
                          {file.label === 'Modified' ? 'M' : file.label === 'Added' ? 'A' : file.label === 'Deleted' ? 'D' : file.label === 'Renamed' ? 'R' : file.label === 'Untracked' ? 'U' : file.label === 'Conflicted' ? '!' : '•'}
                        </span>
                        <span className="change-path" title={file.path}>
                          {file.path}
                        </span>
                        <span className="change-actions" onClick={(event) => event.stopPropagation()}>
                          {file.stage === 'staged' ? (
                            <>
                              <IconButton label="Unstage" onClick={() => void unstageFiles([file.path])}>
                                <Minus size={12} />
                              </IconButton>
                              {file.index !== '.' && file.worktree !== '.' ? (
                                <IconButton label="Stage remaining changes" onClick={() => void stageFiles([file.path])}>
                                  <Plus size={12} />
                                </IconButton>
                              ) : null}
                            </>
                          ) : (
                            <IconButton label="Stage" onClick={() => void stageFiles([file.path])}>
                              <Plus size={12} />
                            </IconButton>
                          )}
                          <IconButton label="Discard changes" danger onClick={() => setDiscardTarget([file])}>
                            <Undo2 size={12} />
                          </IconButton>
                        </span>
                      </div>
                    ))}
                  </section>
                ))
              )}
            </div>

            <div className="commit-box">
              <div className="commit-box-head">
                <span>Commit</span>
                <Badge tone={status.stagedCount ? 'green' : 'neutral'}>{status.stagedCount} staged</Badge>
              </div>
              <Field label="Author identity">
                <IdentitySelect value={identity?.id} onChange={(value) => void saveIdentity(value)} />
              </Field>
              <TextArea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={`Commit message${status.branch ? ` for ${status.branch}` : ''}…`}
                rows={4}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void commit()
                  }
                }}
              />
              <div className="commit-options">
                <label className="checkbox-row">
                  <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
                  Amend last commit
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={signoff} onChange={(event) => setSignoff(event.target.checked)} />
                  Sign off
                </label>
              </div>
              <Button
                variant="primary"
                className="commit-submit"
                icon={<GitCommitHorizontal size={15} />}
                loading={committing}
                disabled={(!status.stagedCount && !amend) || !message.trim()}
                onClick={() => void commit()}
              >
                Commit{status.stagedCount ? ` ${status.stagedCount} file${status.stagedCount === 1 ? '' : 's'}` : ''}
              </Button>
              <p className="commit-hint">
                {identity ? `${identity.name} <${identity.email}>` : 'No identity configured'} · {window.gitgrove.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter
              </p>
            </div>
          </aside>

          <main className="diff-pane">
            {!selectedFile ? (
              <EmptyState
                icon={<FileWarning size={22} />}
                title="Select a file to review changes"
                description="Stage files individually or all at once, then write a commit on the left."
              />
            ) : selectedStatus?.stage === 'untracked' ? (
              <div className="untracked-pane">
                <div className="untracked-banner">
                  <FilePlus2 size={14} /> Untracked file — stage it to include it in the next commit.
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => void stageFiles([selectedStatus.path])}>
                    Stage file
                  </Button>
                </div>
                <Suspense fallback={<LoadingBlock label="Loading file viewer…" />}>
                  <CodeView content={fileContent} loading={diffLoading || contentLoading} />
                </Suspense>
              </div>
            ) : (
              <DiffView
                patch={diff?.patch ?? ''}
                loading={diffLoading}
                emptyLabel={selectedStatus?.stage === 'staged' ? 'No staged changes' : 'No working tree changes'}
              />
            )}
          </main>
        </div>
      ) : (
        <div className="browse-layout">
          <aside className="file-tree">
            <div className="file-tree-head">
              <span>
                <Folder size={13} /> {repo.name}
              </span>
              <IconButton label="Refresh tree" onClick={() => void loadTree('')}>
                <RefreshCw size={12} />
              </IconButton>
            </div>
            <div className="file-tree-body">
              {treeLoading && !tree[''] ? <LoadingBlock label="Reading files…" /> : renderTree('', 0)}
            </div>
          </aside>
          <main className="code-pane">
            {blame ? (
              <div className="blame-view">
                <div className="blame-head">
                  <span>Blame · {browseFile}</span>
                  <Button size="sm" variant="ghost" onClick={() => setBlame(null)}>
                    Back to file
                  </Button>
                </div>
                {blameLoading ? (
                  <LoadingBlock label="Computing blame…" />
                ) : (
                  <div className="blame-lines">
                    {blame.map((line) => (
                      <div className="blame-line" key={`${line.sha}-${line.line}`}>
                        <span className="blame-sha">{line.sha.slice(0, 7)}</span>
                        <span className="blame-author">{line.author}</span>
                        <span className="blame-date">{formatRelativeTime(line.date)}</span>
                        <span className="blame-number">{line.line}</span>
                        <code>{line.content || ' '}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {browseFile ? (
                  <div className="code-actions">
                    <span className="code-actions-path">{browseFile}</span>
                    <Badge tone="neutral">{languageFromPath(browseFile)}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<FolderOpen size={13} />}
                      onClick={() =>
                        void call('app.openPath', { path: `${repo.path}/${browseFile}` }).then((result) => {
                          if (!result.ok) notifyError(result.error || 'Could not open file')
                        })
                      }
                    >
                      Open externally
                    </Button>
                  </div>
                ) : null}
                <Suspense fallback={<LoadingBlock label="Loading file viewer…" />}>
                  <CodeView content={fileContent} loading={contentLoading} />
                </Suspense>
              </>
            )}
          </main>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(discardTarget)}
        title="Discard changes"
        message={
          <>
            Discard changes in {discardTarget?.length === 1 ? <strong>{discardTarget[0]?.path}</strong> : `${discardTarget?.length ?? 0} files`}?
            This cannot be undone.
          </>
        }
        confirmLabel="Discard"
        danger
        onCancel={() => setDiscardTarget(null)}
        onConfirm={() => void doDiscard()}
      />
    </div>
  )
}
