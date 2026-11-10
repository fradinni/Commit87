import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileWarning,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Link2,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Undo2,
  UserRound
} from 'lucide-react'
import type { BlameLine, DiffResult, DirEntry, FileContent, StatusFile } from '@shared/types'
import { activeIdentity, discardNotice, useStore } from '../store'
import { call, errorMessage } from '../lib/ipc'
import { actionPaths, actionPathsFor, fileFacets, stagePaths, stagePathsFor, type FileFacet } from '../lib/files'
import { createRequestGuard } from '../lib/request'
import { formatRelativeTime, languageFromPath } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, LoadingBlock, Select, TextArea } from '../components/ui'
import { DiffView } from '../components/DiffView'
import { ConflictView } from '../components/ConflictView'
import { IdentitySelect } from '../components/selectors'

// highlight.js is the largest renderer dependency. Load it only when a file is
// actually opened instead of parsing it during the first paint of the graph.
const CodeView = lazy(() => import('../components/CodeView').then((module) => ({ default: module.CodeView })))

type FilesTab = 'changes' | 'browse'

/** Which side of a path the reviewer picked; the facet key also carries it. */
interface FacetSelection {
  path: string
  side: FileFacet['side']
}

type ChangeGroup = {
  key: string
  label: string
  tone: 'green' | 'blue' | 'amber' | 'red'
  facets: FileFacet[]
}

export function FilesView() {
  const repo = useStore((state) => state.currentRepo)
  const repoPath = repo?.path ?? ''
  const status = useStore((state) => state.status)
  const repoDefaults = useStore((state) => state.repoDefaults)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshAll = useStore((state) => state.refreshAll)
  const refreshStatus = useStore((state) => state.refreshStatus)
  const commitMessage = useStore((state) => state.commitMessage)
  const commitAmend = useStore((state) => state.commitAmend)
  const commitSignoff = useStore((state) => state.commitSignoff)
  const setCommitDraft = useStore((state) => state.setCommitDraft)
  const clearCommitDraft = useStore((state) => state.clearCommitDraft)

  const [tab, setTab] = useState<FilesTab>('changes')
  const [selected, setSelected] = useState<FacetSelection | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)
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

  // Each editable surface keeps its own identity guard: a late response (or a
  // late `finally`) must never populate the editor for a newer selection.
  const previewGuard = useRef(createRequestGuard())
  const browseGuard = useRef(createRequestGuard())
  const blameGuard = useRef(createRequestGuard())
  const treeGuards = useRef(new Map<string, ReturnType<typeof createRequestGuard>>())
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    setIdentityId(repoDefaults.identityId)
  }, [repoDefaults.identityId, repo?.path])

  const facets = useMemo(() => (status ? status.files.flatMap(fileFacets) : []), [status])

  const selectedFacet = useMemo(() => {
    if (!selected) return null
    return (
      facets.find((facet) => facet.path === selected.path && facet.side === selected.side) ??
      facets.find((facet) => facet.path === selected.path) ??
      null
    )
  }, [facets, selected])

  const groups = useMemo<ChangeGroup[]>(
    () =>
      [
        { key: 'staged', label: 'Staged', tone: 'green' as const, facets: facets.filter((facet) => facet.stage === 'staged') },
        { key: 'unstaged', label: 'Changes', tone: 'blue' as const, facets: facets.filter((facet) => facet.stage === 'unstaged') },
        { key: 'untracked', label: 'Untracked', tone: 'amber' as const, facets: facets.filter((facet) => facet.stage === 'untracked') },
        { key: 'conflicted', label: 'Conflicts', tone: 'red' as const, facets: facets.filter((facet) => facet.stage === 'conflicted') }
      ].filter((group) => group.facets.length > 0),
    [facets]
  )
  const visibleFacets = useMemo(() => groups.flatMap((group) => group.facets), [groups])
  const stagedFacets = useMemo(() => groups.find((group) => group.key === 'staged')?.facets ?? [], [groups])

  // A path that is both staged and modified is shown twice; label each row so
  // the reviewer knows which recorded version is on screen.
  const splitPaths = useMemo(() => {
    const counts = new Map<string, number>()
    for (const facet of facets) counts.set(facet.path, (counts.get(facet.path) ?? 0) + 1)
    return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path))
  }, [facets])

  const loadPreview = useCallback(
    async (facet: FileFacet) => {
      if (!repoPath) return
      const token = previewGuard.current.begin(`${repoPath}|${facet.side}|${facet.path}`)
      setDiffLoading(true)
      setDiff(null)
      setFileContent(null)
      setContentError(null)
      try {
        // Git emits a combined diff (diff --cc) for unmerged paths, which the
        // unified-diff view cannot render. Show the working-tree file with its
        // conflict markers instead so both sides are visible.
        if (facet.stage === 'untracked' || facet.stage === 'conflicted') {
          const content = await call('git.fileContent', { path: repoPath, file: facet.path, from: 'worktree' })
          if (!previewGuard.current.isCurrent(token)) return
          setFileContent(content)
          return
        }
        const result = await call('git.diff', {
          repoPath,
          path: facet.path,
          staged: facet.side === 'index'
        })
        if (!previewGuard.current.isCurrent(token)) return
        setDiff(result)
      } catch (error) {
        if (!previewGuard.current.isCurrent(token)) return
        if (facet.stage === 'conflicted') setContentError(errorMessage(error))
        notifyError(error)
      } finally {
        if (previewGuard.current.isCurrent(token)) setDiffLoading(false)
      }
    },
    [notifyError, repoPath]
  )

  useEffect(() => {
    if (!selectedFacet) {
      previewGuard.current.invalidate()
      setDiff(null)
      setFileContent(null)
      setContentError(null)
      setDiffLoading(false)
      return
    }
    void loadPreview(selectedFacet)
  }, [loadPreview, repoPath, selectedFacet])

  const loadTree = useCallback(
    async (dir = '') => {
      if (!repoPath) return
      const key = `${repoPath}|${dir}`
      let guard = treeGuards.current.get(key)
      if (!guard) {
        guard = createRequestGuard()
        treeGuards.current.set(key, guard)
      }
      const token = guard.begin(key)
      setTreeLoading(true)
      try {
        const entries = await call('git.fileTree', { path: repoPath, dir })
        if (!guard.isCurrent(token)) return
        setTree((current) => ({ ...current, [dir]: entries }))
      } catch (error) {
        if (!guard.isCurrent(token)) return
        notifyError(error)
      } finally {
        if (guard.isCurrent(token)) setTreeLoading(false)
      }
    },
    [notifyError, repoPath]
  )

  useEffect(() => {
    if (!repoPath) return
    previewGuard.current.invalidate()
    browseGuard.current.invalidate()
    blameGuard.current.invalidate()
    for (const guard of treeGuards.current.values()) guard.invalidate()
    treeGuards.current.clear()
    setTree({})
    setExpanded(new Set())
    setBrowseFile(null)
    setFileContent(null)
    setBlame(null)
    setSelected(null)
    setDiff(null)
    setContentError(null)
    setDiffLoading(false)
    setContentLoading(false)
    setBlameLoading(false)
    setTreeLoading(false)
    if (tab === 'browse') void loadTree('')
  }, [repoPath, tab, loadTree])

  useEffect(() => () => {
    previewGuard.current.invalidate()
    browseGuard.current.invalidate()
    blameGuard.current.invalidate()
    for (const guard of treeGuards.current.values()) guard.invalidate()
    treeGuards.current.clear()
  }, [])

  // A staged/discarded path may disappear from the status entirely.
  useEffect(() => {
    if (!selected) return
    if (facets.some((facet) => facet.path === selected.path)) return
    setSelected(null)
  }, [facets, selected])

  const loadFile = useCallback(
    async (file: string) => {
      if (!repoPath) return
      // A blame request for the previous file must not arrive after this one.
      blameGuard.current.invalidate()
      const token = browseGuard.current.begin(`${repoPath}|${browseFrom}|${file}`)
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
        if (!browseGuard.current.isCurrent(token)) return
        setFileContent(content)
      } catch (error) {
        if (!browseGuard.current.isCurrent(token)) return
        notifyError(error)
      } finally {
        if (browseGuard.current.isCurrent(token)) setContentLoading(false)
      }
    },
    [browseFrom, notifyError, repoPath]
  )

  useEffect(() => {
    if (browseFile && tab === 'browse' && !blame) void loadFile(browseFile)
  }, [browseFrom, browseFile, tab, blame, loadFile])

  const loadBlame = async (): Promise<void> => {
    if (!repo || !browseFile) return
    const token = blameGuard.current.begin(`${repo.path}|${browseFile}`)
    setBlameLoading(true)
    try {
      const lines = await call('git.blame', { path: repo.path, file: browseFile })
      if (!blameGuard.current.isCurrent(token)) return
      setBlame(lines)
    } catch (error) {
      if (!blameGuard.current.isCurrent(token)) return
      notifyError(error)
    } finally {
      if (blameGuard.current.isCurrent(token)) setBlameLoading(false)
    }
  }

  if (!repo) return null
  if (repo.isBare) {
    return (
      <div className="view files-view">
        <EmptyState
          icon={<GitCommitHorizontal size={20} />}
          title="Bare repository"
          description="There is no working tree to stage. Use the commit graph to inspect history, branches, tags and remotes."
        />
      </div>
    )
  }
  if (!status) return null

  const stageFiles = async (files: string[]): Promise<void> => {
    try {
      await call('git.stage', { path: repo.path, files })
      await refreshStatus(repo.path)
      await useStore.getState().refreshBranches(repo.path)
    } catch (error) {
      notifyError(error)
    }
  }

  const unstageFiles = async (files: string[]): Promise<void> => {
    try {
      await call('git.unstage', { path: repo.path, files })
      await refreshStatus(repo.path)
    } catch (error) {
      notifyError(error)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    try {
      const result = await call('git.discard', {
        path: repo.path,
        files: actionPathsFor(discardTarget),
        includeUntracked: discardTarget.some((file) => file.stage === 'untracked')
      })
      setDiscardTarget(null)
      previewGuard.current.invalidate()
      setSelected(null)
      setDiff(null)
      await refreshAll(repo.path)
      // A failed tracked restore is reported instead of announcing success.
      const notice = discardNotice(result)
      notify(notice.message, notice.kind)
    } catch (error) {
      notifyError(error)
    }
  }

  const commit = async (): Promise<void> => {
    if (!commitMessage.trim()) {
      notify('Write a commit message first', 'info')
      return
    }
    setCommitting(true)
    try {
      await call('git.commit', {
        repoPath: repo.path,
        message: commitMessage,
        amend: commitAmend,
        signoff: commitSignoff,
        // Send only the identity picked for this repository: when none is
        // picked, main resolves the repository-local config before the
        // application default, so a fallback is never turned into an override.
        identityId
      })
      clearCommitDraft()
      previewGuard.current.invalidate()
      setSelected(null)
      setDiff(null)
      setFileContent(null)
      await refreshAll(repo.path)
      notify('Commit created', 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setCommitting(false)
    }
  }

  const selectFacet = (facet: FileFacet): void => {
    // Invalidate before the next render so a response that lands between the
    // click and the effect cannot populate the editor for the new target, and
    // never render the previous selection's bytes under the new row.
    previewGuard.current.invalidate()
    setSelected({ path: facet.path, side: facet.side })
    setDiff(null)
    setFileContent(null)
    setContentError(null)
  }

  const focusFacet = (facet: FileFacet): void => {
    selectFacet(facet)
    rowRefs.current.get(facet.key)?.focus()
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>('[role="option"]')
    if (!row) return
    // Nested action buttons keep their own keyboard behavior.
    if (target !== row && target.closest('button, a, input, select, textarea')) return
    const index = visibleFacets.findIndex((facet) => facet.key === row.dataset.facetKey)
    if (index < 0) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectFacet(visibleFacets[index])
      return
    }
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(index + 1, visibleFacets.length - 1)
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = visibleFacets.length - 1
    else return
    event.preventDefault()
    focusFacet(visibleFacets[next])
  }

  const saveIdentity = async (value: string | undefined): Promise<void> => {
    setIdentityId(value)
    try {
      const defaults = await call('repo.setDefaults', {
        path: repo.path,
        defaults: { ...repoDefaults, identityId: value }
      })
      useStore.getState().updateTab(repo.path, { repoDefaults: defaults })
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
      if (entry.type === 'symlink') {
        // Links are listed but never followed, so they are not selectable.
        return (
          <div
            key={entry.path}
            className="tree-row is-file is-symlink"
            style={{ paddingLeft: 8 + depth * 14 + 16 }}
            title="Symbolic links are not opened inside the app"
          >
            <Link2 size={13} />
            <span>{entry.name}</span>
            <span className="change-side">link</span>
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

  const discardRename = discardTarget?.length === 1 && discardTarget[0]?.rename ? discardTarget[0] : null
  const discardPaths = discardTarget ? actionPathsFor(discardTarget) : []
  const stagedCount = stagedFacets.length
  const firstFacetKey = visibleFacets[0]?.key
  const activeFacetKey = selectedFacet?.key

  return (
    <div className="view files-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <div className="segmented">
            <button className={tab === 'changes' ? 'is-active' : ''} onClick={() => setTab('changes')}>
              <ListTree size={14} /> Changes
              {facets.length ? <span className="seg-count">{facets.length}</span> : null}
            </button>
            <button className={tab === 'browse' ? 'is-active' : ''} onClick={() => setTab('browse')}>
              <FolderOpen size={14} /> Browse code
            </button>
          </div>
        </div>
        <div className="toolbar-actions">
          {tab === 'changes' ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus size={13} />}
                onClick={() => void stageFiles(stagePathsFor(status.files))}
                disabled={!status.files.length}
              >
                Stage all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Minus size={13} />}
                onClick={() => void unstageFiles(actionPathsFor(stagedFacets.map((facet) => facet.file)))}
                disabled={!stagedCount}
              >
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
            <div className="staging-scroll" role="listbox" aria-label="Changed files" onKeyDown={onListKeyDown}>
              {groups.length === 0 ? (
                <EmptyState icon={<GitCommitHorizontal size={20} />} title="Working tree clean" description="No staged, modified or untracked files." />
              ) : (
                groups.map((group) => (
                  <section className="change-group" key={group.key} role="group" aria-label={group.label}>
                    <header className="change-group-head">
                      <span>
                        <Badge tone={group.tone}>{group.label}</Badge>
                        <span className="change-count">{group.facets.length}</span>
                      </span>
                      <span className="change-group-actions">
                        {group.key === 'staged' ? (
                          <IconButton label="Unstage all" onClick={() => void unstageFiles(actionPathsFor(group.facets.map((facet) => facet.file)))}>
                            <Minus size={13} />
                          </IconButton>
                        ) : (
                          <IconButton label="Stage all" onClick={() => void stageFiles(stagePathsFor(group.facets.map((facet) => facet.file)))}>
                            <Plus size={13} />
                          </IconButton>
                        )}
                      </span>
                    </header>
                    {group.facets.map((facet) => (
                      <div
                        key={facet.key}
                        role="option"
                        aria-selected={activeFacetKey === facet.key}
                        aria-label={`${facet.label}: ${facet.path}${facet.side === 'index' ? ' (staged)' : ''}`}
                        tabIndex={activeFacetKey === facet.key || (!selectedFacet && firstFacetKey === facet.key) ? 0 : -1}
                        data-facet-key={facet.key}
                        ref={(element) => {
                          if (element) rowRefs.current.set(facet.key, element)
                          else rowRefs.current.delete(facet.key)
                        }}
                        className={`change-row ${activeFacetKey === facet.key ? 'is-active' : ''}`}
                        onClick={() => selectFacet(facet)}
                      >
                        <span className={`change-status change-${facet.code}`}>{facet.code}</span>
                        <span className="change-path" title={facet.path}>
                          {facet.path}
                        </span>
                        {splitPaths.has(facet.path) ? (
                          <span className="change-side">{facet.side === 'index' ? 'staged' : 'worktree'}</span>
                        ) : null}
                        <span className="change-actions" onClick={(event) => event.stopPropagation()}>
                          {facet.side === 'index' ? (
                            <>
                              <IconButton label="Unstage" onClick={() => void unstageFiles(actionPaths(facet.file))}>
                                <Minus size={12} />
                              </IconButton>
                              <IconButton label="Discard changes" danger onClick={() => setDiscardTarget([facet.file])}>
                                <Undo2 size={12} />
                              </IconButton>
                            </>
                          ) : (
                            <>
                              <IconButton label="Stage" onClick={() => void stageFiles(stagePaths(facet.file))}>
                                <Plus size={12} />
                              </IconButton>
                              <IconButton label="Discard changes" danger onClick={() => setDiscardTarget([facet.file])}>
                                <Undo2 size={12} />
                              </IconButton>
                            </>
                          )}
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
                <Badge tone={stagedCount ? 'green' : 'neutral'}>{stagedCount} staged</Badge>
              </div>
              <Field label="Author identity">
                <IdentitySelect value={identity?.id} onChange={(value) => void saveIdentity(value)} />
              </Field>
              <TextArea
                value={commitMessage}
                onChange={(event) => setCommitDraft({ message: event.target.value })}
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
                  <input type="checkbox" checked={commitAmend} onChange={(event) => setCommitDraft({ amend: event.target.checked })} />
                  Amend last commit
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={commitSignoff} onChange={(event) => setCommitDraft({ signoff: event.target.checked })} />
                  Sign off
                </label>
              </div>
              <Button
                variant="primary"
                className="commit-submit"
                icon={<GitCommitHorizontal size={15} />}
                loading={committing}
                disabled={(!stagedCount && !commitAmend) || !commitMessage.trim()}
                onClick={() => void commit()}
              >
                Commit{stagedCount ? ` ${stagedCount} file${stagedCount === 1 ? '' : 's'}` : ''}
              </Button>
              <p className="commit-hint">
                {identity ? `${identity.name} <${identity.email}>` : 'No identity configured'} · {window.commit87.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter
              </p>
            </div>
          </aside>

          <main className="diff-pane">
            {!selectedFacet ? (
              <EmptyState
                icon={<FileWarning size={22} />}
                title="Select a file to review changes"
                description="Stage files individually or all at once, then write a commit on the left."
              />
            ) : selectedFacet.stage === 'untracked' ? (
              <div className="untracked-pane">
                <div className="untracked-banner">
                  <FilePlus2 size={14} /> Untracked file — stage it to include it in the next commit.
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => void stageFiles(stagePaths(selectedFacet.file))}>
                    Stage file
                  </Button>
                </div>
                <Suspense fallback={<LoadingBlock label="Loading file viewer…" />}>
                  <CodeView content={fileContent} loading={diffLoading || contentLoading} />
                </Suspense>
              </div>
            ) : selectedFacet.stage === 'conflicted' ? (
              <ConflictView
                key={selectedFacet.key}
                repoPath={repo.path}
                file={selectedFacet.file}
                content={fileContent}
                loading={diffLoading}
                error={contentError}
                onReload={() => void loadPreview(selectedFacet)}
                onOpen={() =>
                  void call('app.openPath', { path: `${repo.path}/${selectedFacet.path}` }).then((result) => {
                    if (!result.ok) notifyError(result.error || 'Could not open file')
                  })
                }
              />
            ) : (
              <DiffView
                patch={diff?.patch ?? ''}
                loading={diffLoading}
                emptyLabel={selectedFacet.side === 'index' ? 'No staged changes' : 'No working tree changes'}
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
            {discardRename ? (
              <>
                Discard the rename <strong>{discardRename.origPath}</strong> → <strong>{discardRename.path}</strong>?
              </>
            ) : (
              <>
                Discard changes in{' '}
                {discardPaths.length === 1 ? <strong>{discardPaths[0]}</strong> : `${discardPaths.length} files`}?
              </>
            )}{' '}
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
