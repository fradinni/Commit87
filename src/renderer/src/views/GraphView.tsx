import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode
} from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  Calendar,
  Check,
  CircleDot,
  Cloud,
  Copy,
  CornerDownRight,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  RotateCcw,
  Search,
  Tag,
  Undo2,
  User,
  X
} from 'lucide-react'
import type { Commit, DiffResult } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { buildGraph, classifyRefs, GRAPH_PADDING, LANE_GAP } from '../lib/graph'
import type { ClassifiedRef } from '../lib/graph'
import {
  applyCommitSelection,
  normalizeCommitSelection,
  orderSelectedCommits,
  reconcileCommitSelection
} from '../lib/commit-selection'
import { formatDate, formatRelativeTime, initials, shortSha } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Modal, Select, TextInput, Field } from '../components/ui'
import { DiffView } from '../components/DiffView'

const ROW_HEIGHT = 32
const REFS_WIDTH = 176
const MAX_VISIBLE_REFS = 2

interface GraphColumnStyle extends CSSProperties {
  '--graph-w': string
  '--refs-w': string
}

interface CommitTarget {
  sha: string
  subject: string
}

interface GraphMenuState {
  left: number
  top: number
  maxHeight: number
}

type GraphMenuEntry =
  | {
      kind: 'item'
      id: string
      label: string
      icon: ReactNode
      danger?: boolean
      disabled?: boolean
      run: () => void
    }
  | { kind: 'separator'; id: string }

export function GraphView() {
  const repo = useStore((state) => state.currentRepo)
  const commits = useStore((state) => state.commits)
  const branches = useStore((state) => state.branches)
  const tags = useStore((state) => state.tags)
  const config = useStore((state) => state.config)
  const detection = useStore((state) => state.detection)
  const selectedCommit = useStore((state) => state.selectedCommit)
  const selectedCommits = useStore((state) => state.selectedCommits)
  const selectionAnchor = useStore((state) => state.selectionAnchor)
  const selectCommit = useStore((state) => state.selectCommit)
  const selectCommits = useStore((state) => state.selectCommits)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const currentBranch = useStore((state) => state.status?.branch ?? state.currentRepo?.currentBranch ?? null)
  const headSha = useStore((state) => state.status?.headSha ?? null)
  const [query, setQuery] = [useStore((state) => state.graphQuery), useStore((state) => state.setGraphQuery)]
  const [branch, setBranch] = [useStore((state) => state.graphBranch), useStore((state) => state.setGraphBranch)]
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detail, setDetail] = useState<Commit | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [branchModal, setBranchModal] = useState(false)
  const [branchTarget, setBranchTarget] = useState<CommitTarget | null>(null)
  const [tagModal, setTagModal] = useState(false)
  const [tagTarget, setTagTarget] = useState<CommitTarget | null>(null)
  const [formName, setFormName] = useState('')
  const [formMessage, setFormMessage] = useState('')
  const [checkoutNew, setCheckoutNew] = useState(true)
  const [resetModal, setResetModal] = useState(false)
  const [resetTarget, setResetTarget] = useState<CommitTarget | null>(null)
  const [resetMode, setResetMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => Promise<void> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<GraphMenuState | null>(null)
  // The loaded order from the previous render, so a commit that was never in
  // the graph (a refs-panel jump, for example) is not mistaken for a removed one.
  const loadedOrderRef = useRef<string[]>([])

  const layout = useMemo(() => buildGraph(commits, ROW_HEIGHT), [commits])
  const graphStyle = useMemo<GraphColumnStyle>(
    () => ({ '--graph-w': `${layout.width}px`, '--refs-w': `${REFS_WIDTH}px` }),
    [layout.width]
  )
  const commitOrder = useMemo(() => commits.map((commit) => commit.sha), [commits])
  const commitOrderKey = commitOrder.join('\n')
  const selectionKey = selectedCommits.join('\n')
  const selectedSet = useMemo(() => new Set(selectedCommits), [selectedCommits])
  const tagNames = useMemo(() => new Set(tags.map((item) => item.name)), [tags])
  const localBranchNames = useMemo(
    () => new Set(branches.filter((item) => item.type === 'branch').map((item) => item.shortName)),
    [branches]
  )
  const refsBySha = useMemo(() => {
    const map = new Map<string, ClassifiedRef[]>()
    for (const commit of commits) {
      map.set(commit.sha, classifyRefs(commit.refs, { tags: tagNames, branches: localBranchNames, currentBranch }))
    }
    return map
  }, [commits, localBranchNames, tagNames, currentBranch])
  const detailRefs = useMemo(
    () => (detail ? classifyRefs(detail.refs, { tags: tagNames, branches: localBranchNames, currentBranch }) : []),
    [detail, localBranchNames, tagNames, currentBranch]
  )
  const activeCommit = useMemo(
    () => commits.find((commit) => commit.sha === selectedCommit) ?? null,
    [commits, selectedCommit]
  )
  const selectionCount = selectedCommits.length
  const multiSelected = selectionCount > 1
  const selectedRows = useMemo(() => commits.filter((commit) => selectedSet.has(commit.sha)), [commits, selectedSet])
  const hasMergeSelection =
    selectedRows.some((commit) => commit.parents.length > 1) ||
    Boolean(detail && detail.sha === selectedCommit && detail.parents.length > 1)

  const runQuery = useCallback(
    async (append = false) => {
      if (!repo) return
      if (append) setLoadingMore(true)
      else setLoading(true)
      try {
        const limit = config?.maxCommits ?? 500
        const fresh = await call('git.log', {
          repoPath: repo.path,
          limit: append ? 200 : limit,
          skip: append ? commits.length : 0,
          branch: branch || undefined,
          all: !branch,
          search: query.trim() || undefined
        })
        const next = append ? [...commits, ...fresh.filter((item) => !commits.some((existing) => existing.sha === item.sha))] : fresh
        useStore.getState().updateTab(repo.path, { commits: next })
        if (!append && useStore.getState().currentRepo?.path === repo.path) {
          // A refresh or filter keeps whatever part of the selection is still
          // listed (and its active commit); otherwise it selects the newest one.
          const state = useStore.getState()
          const order = next.map((item) => item.sha)
          const kept = normalizeCommitSelection(order, state.selectedCommits)
          if (kept.length) {
            const active = state.selectedCommit && kept.includes(state.selectedCommit) ? state.selectedCommit : kept[0] ?? null
            const anchor = state.selectionAnchor && order.includes(state.selectionAnchor) ? state.selectionAnchor : active
            selectCommits(kept, active, anchor)
          } else {
            selectCommit(fresh[0]?.sha ?? null)
          }
        }
      } catch (error) {
        notifyError(error)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [branch, commits, config?.maxCommits, notifyError, query, repo, selectCommit, selectCommits]
  )

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setDiffLoading(true)
    setDiff(null)
    setDiffFile(null)
    const sha = selectedCommit
    const repoPath = repo.path
    if (!sha) {
      setDetail(null)
      setDiffLoading(false)
      return
    }
    const cached = commits.find((commit) => commit.sha === sha) ?? null
    setDetail(cached)
    void Promise.all([
      call('git.commitDetail', { path: repoPath, sha }),
      call('git.diff', { repoPath, commit: sha })
    ])
      .then(([commit, result]) => {
        if (cancelled) return
        setDetail(commit)
        setDiff(result)
      })
      .catch((error) => {
        if (cancelled) return
        notifyError(error)
        // The commit can disappear after a background history rewrite while
        // another tab was open; do not keep a selection that no longer exists.
        if (error instanceof Error && /Commit not found/.test(error.message)) {
          if (useStore.getState().selectedCommit === sha) selectCommits([], null, null)
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [notifyError, repo?.path, selectCommits, selectedCommit])

  // A filter, refresh or force-push can remove selected commits; keep the
  // selection and the details pane on commits that still exist.
  useEffect(() => {
    const order = commitOrderKey ? commitOrderKey.split('\n') : []
    const previousOrder = loadedOrderRef.current
    loadedOrderRef.current = order
    const previous = selectionKey ? selectionKey.split('\n') : []
    const next = reconcileCommitSelection(order, previousOrder, {
      selected: previous,
      active: selectedCommit,
      anchor: selectionAnchor
    })
    if (next) selectCommits(next.selected, next.active, next.anchor)
  }, [commitOrderKey, selectCommits, selectedCommit, selectionAnchor, selectionKey])

  useEffect(() => {
    if (!menu) return undefined
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    const dismiss = (): void => setMenu(null)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  if (!repo) return null

  const openWeb = async (suffix: string): Promise<void> => {
    if (!detection.webUrlBase) {
      notify('Open the repository once from a configured remote to enable web links', 'info')
      return
    }
    const base = detection.webUrlBase
    const url =
      detection.provider === 'gitlab'
        ? `${base}/-/commit/${suffix}`
        : detection.provider === 'bitbucket'
          ? `${base}/commits/${suffix}`
          : `${base}/commit/${suffix}`
    await call('app.openExternal', { url }).catch(notifyError)
  }

  const copyText = (value: string, label: string): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => notify(`${label} copied`, 'success'))
      .catch((error) => notifyError(error))
  }

  const createBranch = async (): Promise<void> => {
    if (!formName.trim() || !branchTarget) return
    setBusy(true)
    try {
      await call('git.createBranch', {
        path: repo.path,
        name: formName.trim(),
        startPoint: branchTarget.sha,
        checkout: checkoutNew
      })
      await useStore.getState().refreshAll(repo.path)
      notify(`Branch ${formName.trim()} created`, 'success')
      setBranchModal(false)
      setFormName('')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const createTag = async (): Promise<void> => {
    if (!formName.trim() || !tagTarget) return
    setBusy(true)
    try {
      await call('git.tagCreate', {
        repoPath: repo.path,
        name: formName.trim(),
        message: formMessage.trim() || undefined,
        commit: tagTarget.sha,
        identityId: activeIdentity()?.id
      })
      await useStore.getState().refreshTags(repo.path)
      notify(`Tag ${formName.trim()} created`, 'success')
      setTagModal(false)
      setFormName('')
      setFormMessage('')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const resetTo = async (): Promise<void> => {
    if (!resetTarget) return
    setBusy(true)
    try {
      await call('git.reset', { repoPath: repo.path, commit: resetTarget.sha, mode: resetMode })
      await useStore.getState().refreshAll(repo.path)
      notify(`Reset ${resetMode} to ${shortSha(resetTarget.sha)}`, 'success')
      setResetModal(false)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const runHistoryAction = async (action: 'cherry-pick' | 'revert', shas: string[]): Promise<void> => {
    if (!shas.length) return
    const result =
      action === 'cherry-pick'
        ? await call('git.cherryPick', { path: repo.path, shas, identityId: activeIdentity()?.id })
        : await call('git.revert', { path: repo.path, shas, identityId: activeIdentity()?.id })
    // A conflict or a hook stop leaves the repository mid-operation; refresh so
    // the status bar offers Continue, Skip and Abort, and report it as an error.
    await useStore.getState().refreshAll(repo.path)
    const output = result.output.trim()
    if (result.exitCode !== 0) {
      notify(output || `${action === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} did not finish`, 'error')
      return
    }
    const fallback =
      shas.length > 1
        ? `${action === 'cherry-pick' ? 'Cherry-picked' : 'Reverted'} ${shas.length} commits`
        : action === 'cherry-pick'
          ? 'Cherry-picked'
          : 'Reverted'
    notify(output || fallback, 'success')
  }

  const confirmHistory = (action: 'cherry-pick' | 'revert'): void => {
    const shas = orderSelectedCommits(commitOrder, selectedCommits, action)
    if (!shas.length) return
    const count = shas.length
    const many = count > 1
    setConfirm({
      title: action === 'cherry-pick' ? `Cherry-pick ${many ? `${count} commits` : 'this commit'}?` : `Revert ${many ? `${count} commits` : 'this commit'}?`,
      message:
        action === 'cherry-pick'
          ? `Apply ${many ? `${count} selected commits` : shortSha(shas[0])} onto ${currentBranch ?? 'the current HEAD'}, oldest first.`
          : `Create ${many ? `${count} new commits` : 'a new commit'} that ${many ? 'reverse the selected commits' : `reverses ${shortSha(shas[0])}`}, newest first.`,
      run: () => runHistoryAction(action, shas)
    })
  }

  const openSingle = (commit: CommitTarget | null | undefined, kind: 'branch' | 'tag' | 'reset'): void => {
    if (!commit) return
    if (kind === 'branch') {
      setBranchTarget(commit)
      setFormName('')
      setBranchModal(true)
      return
    }
    if (kind === 'tag') {
      setTagTarget(commit)
      setFormName('')
      setFormMessage('')
      setTagModal(true)
      return
    }
    setResetTarget(commit)
    setResetModal(true)
  }

  const openMenu = (left: number, top: number): void => {
    const width = 260
    // Keep room for the header and a few items so a bottom-edge menu scrolls
    // inside the viewport instead of spilling past it.
    const minHeight = 180
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const clampedLeft = Math.max(6, Math.min(left, viewportWidth - width - 6))
    const clampedTop = Math.max(6, Math.min(top, viewportHeight - minHeight - 8))
    setMenu({
      left: clampedLeft,
      top: clampedTop,
      maxHeight: Math.max(minHeight, viewportHeight - clampedTop - 8)
    })
  }

  const handleContextMenu = (event: ReactMouseEvent, commit: Commit): void => {
    event.preventDefault()
    event.stopPropagation()
    const state = useStore.getState()
    if (!state.selectedCommits.includes(commit.sha)) {
      selectCommits([commit.sha], commit.sha, commit.sha)
    } else if (state.selectedCommit !== commit.sha) {
      selectCommits(state.selectedCommits, commit.sha, state.selectionAnchor)
    }
    openMenu(event.clientX, event.clientY)
  }

  const handleRowClick = (event: ReactMouseEvent, sha: string): void => {
    const state = useStore.getState()
    const result = applyCommitSelection(
      commitOrder,
      { selected: state.selectedCommits, active: state.selectedCommit, anchor: state.selectionAnchor },
      sha,
      { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }
    )
    selectCommits(result.selected, result.active, result.anchor)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const state = useStore.getState()
    if (event.key === 'Escape') {
      if (menu) {
        setMenu(null)
      } else if (state.selectedCommits.length) {
        event.preventDefault()
        selectCommits([], null, null)
      }
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'a') {
      if (!commitOrder.length) return
      event.preventDefault()
      selectCommits(commitOrder, state.selectedCommit ?? commitOrder[0] ?? null, commitOrder[0] ?? null)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (!commitOrder.length) return
    event.preventDefault()
    const currentIndex = state.selectedCommit ? commitOrder.indexOf(state.selectedCommit) : -1
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(commitOrder.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex < 0 ? commitOrder.length - 1 : currentIndex - 1)
    const target = commitOrder[nextIndex]
    if (!target) return
    const reveal = (): void => {
      const row = event.currentTarget.querySelector(`[data-sha="${CSS.escape(target)}"]`)
      row?.scrollIntoView({ block: 'nearest' })
    }
    if (event.shiftKey) {
      const result = applyCommitSelection(
        commitOrder,
        { selected: state.selectedCommits, active: state.selectedCommit, anchor: state.selectionAnchor },
        target,
        { range: true }
      )
      selectCommits(result.selected, result.active, result.anchor)
      reveal()
      return
    }
    selectCommits([target], target, target)
    reveal()
  }

  const menuEntriesFor = (): GraphMenuEntry[] => {
    const count = selectedCommits.length
    if (!count) return []
    const selectedCommitData =
      count === 1
        ? activeCommit ?? (detail && detail.sha === selectedCommit ? detail : null)
        : null
    const single = selectedCommitData
    const entries: GraphMenuEntry[] = []
    if (single) {
      entries.push({
        kind: 'item',
        id: 'open',
        label: 'Open on forge',
        icon: <ArrowUpRight size={14} />,
        disabled: !detection.webUrlBase,
        run: () => void openWeb(single.sha)
      })
      entries.push({ kind: 'separator', id: 'open-sep' })
    }
    entries.push({
      kind: 'item',
      id: 'copy',
      label: count > 1 ? `Copy ${count} SHAs` : 'Copy commit SHA',
      icon: <Copy size={14} />,
      run: () => copyText(selectedCommits.join('\n'), count > 1 ? 'Commit SHAs' : 'Commit SHA')
    })
    if (single) {
      entries.push({
        kind: 'item',
        id: 'copy-subject',
        label: 'Copy commit subject',
        icon: <Copy size={14} />,
        run: () => copyText(single.subject, 'Commit subject')
      })
    }
    entries.push({ kind: 'separator', id: 'copy-sep' })
    if (single) {
      entries.push({
        kind: 'item',
        id: 'checkout',
        label: 'Check out (detached)',
        icon: <CornerDownRight size={14} />,
        run: () =>
          setConfirm({
            title: 'Check out this commit?',
            message: `This detaches HEAD at ${shortSha(single.sha)}. Your branch will not move.`,
            run: async () => {
              await call('git.checkout', { repoPath: repo.path, branch: single.sha, detach: true })
              await useStore.getState().refreshAll(repo.path)
              notify(`Checked out ${shortSha(single.sha)} (detached)`, 'success')
            }
          })
      })
      entries.push({
        kind: 'item',
        id: 'branch',
        label: 'Create branch here…',
        icon: <GitBranch size={14} />,
        run: () => openSingle(single, 'branch')
      })
      entries.push({
        kind: 'item',
        id: 'tag',
        label: 'Create tag here…',
        icon: <Tag size={14} />,
        run: () => openSingle(single, 'tag')
      })
      entries.push({ kind: 'separator', id: 'create-sep' })
    }
    entries.push({
      kind: 'item',
      id: 'cherry-pick',
      label: count > 1 ? `Cherry-pick ${count} commits` : 'Cherry-pick onto current branch',
      icon: <GitCommitHorizontal size={14} />,
      disabled: hasMergeSelection,
      run: () => confirmHistory('cherry-pick')
    })
    entries.push({
      kind: 'item',
      id: 'revert',
      label: count > 1 ? `Revert ${count} commits` : 'Revert commit',
      icon: <Undo2 size={14} />,
      disabled: hasMergeSelection,
      run: () => confirmHistory('revert')
    })
    if (single) {
      entries.push({ kind: 'separator', id: 'history-sep' })
      entries.push({
        kind: 'item',
        id: 'reset',
        label: 'Reset current branch to here…',
        icon: <RotateCcw size={14} />,
        danger: true,
        run: () => openSingle(single, 'reset')
      })
    }
    entries.push({ kind: 'separator', id: 'select-sep' })
    entries.push({
      kind: 'item',
      id: 'select-all',
      label: 'Select all loaded commits',
      icon: <Check size={14} />,
      disabled: commitOrder.length === 0,
      run: () => {
        selectCommits(commitOrder, selectedCommit ?? commitOrder[0] ?? null, commitOrder[0] ?? null)
      }
    })
    entries.push({
      kind: 'item',
      id: 'clear',
      label: 'Clear selection',
      icon: <X size={14} />,
      run: () => {
        selectCommits([], null, null)
      }
    })
    return entries
  }

  const localBranches = branches.filter((item) => item.type === 'branch')
  const menuEntries = menu ? menuEntriesFor() : []

  return (
    <div className="view graph-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <GitCommitHorizontal size={17} />
          <h2>Commit graph</h2>
          <Badge tone="neutral">{commits.length} loaded</Badge>
          {selectionCount > 1 ? <Badge tone="blue">{selectionCount} selected</Badge> : null}
          {query || branch ? <Badge tone="blue">filtered</Badge> : null}
        </div>
        <div className="toolbar-actions">
          <form
            className="search-box"
            onSubmit={(event) => {
              event.preventDefault()
              void runQuery()
            }}
          >
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commits…" spellCheck={false} />
            {query ? (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={12} />
              </button>
            ) : null}
          </form>
          <Select value={branch} onChange={(event) => setBranch(event.target.value)} title="Filter by branch">
            <option value="">All branches</option>
            {branch && !localBranches.some((item) => item.name === branch) ? (
              <option value={branch}>{branch.replace(/^refs\/(heads|remotes|tags)\//, '')}</option>
            ) : null}
            {localBranches.map((item) => (
              <option key={item.name} value={item.name}>
                {item.shortName}
                {item.isCurrent ? ' (current)' : ''}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="outline" icon={<RotateCcw size={14} />} onClick={() => void runQuery()} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="graph-layout">
        <div className="graph-list-panel">
          {commits.length === 0 && !loading ? (
            <EmptyState
              icon={<GitCommitHorizontal size={22} />}
              title="No commits to show"
              description={
                query || branch
                  ? 'No commits match this filter.'
                  : 'This repository has no commits yet. Stage files and create the first commit from Files & staging.'
              }
              action={
                query || branch ? (
                  <Button size="sm" variant="outline" onClick={() => { setQuery(''); setBranch('') }}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => useStore.getState().setView('files')}>
                    Go to staging
                  </Button>
                )
              }
            />
          ) : (
            <div
              className="commit-scroll"
              tabIndex={0}
              onKeyDown={handleKeyDown}
              onScroll={() => {
                if (menu) setMenu(null)
              }}
            >
              <div className="commit-table" style={graphStyle}>
                <div className="commit-head">
                  <span className="commit-head-refs">Branch / Tag</span>
                  <span className="commit-head-graph">Graph</span>
                  <span>Description</span>
                  <span>Author</span>
                  <span>Date</span>
                  <span>SHA</span>
                </div>
                <div className="commit-rows">
                  <svg
                    className="graph-svg"
                    style={{ left: 'var(--refs-w)' }}
                    width={layout.width}
                    height={Math.max(commits.length * ROW_HEIGHT, 1)}
                    viewBox={`0 0 ${layout.width} ${Math.max(commits.length * ROW_HEIGHT, 1)}`}
                    aria-hidden="true"
                  >
                    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
                      {layout.edges.map((edge, index) => (
                        <path
                          key={`${index}-${edge.fromRow}-${edge.fromLane}-${edge.toRow}-${edge.toLane}`}
                          d={edge.d}
                          stroke={edge.color}
                          strokeWidth={2}
                          opacity={0.9}
                        />
                      ))}
                    </g>
                    {layout.nodes.map((node) => {
                      const active = node.sha === selectedCommit
                      const selected = selectedSet.has(node.sha)
                      const isHead = node.sha === headSha
                      const radius = node.isMerge ? 4.6 : 3.7
                      const cx = GRAPH_PADDING + node.lane * LANE_GAP
                      const cy = node.row * ROW_HEIGHT + ROW_HEIGHT / 2
                      return (
                        <g key={node.sha}>
                          {isHead ? (
                            <circle cx={cx} cy={cy} r={radius + 3.2} fill="none" stroke={node.color} strokeWidth={1} opacity={0.35} />
                          ) : null}
                          <circle
                            cx={cx}
                            cy={cy}
                            r={active ? 5.6 : radius}
                            fill={selected ? node.color : 'var(--bg-panel)'}
                            stroke={node.color}
                            strokeWidth={active ? 2 : 1.8}
                          />
                          {node.isMerge && !selected ? <circle cx={cx} cy={cy} r={1.3} fill={node.color} /> : null}
                        </g>
                      )
                    })}
                  </svg>
                  {layout.rows.map(({ commit, color }) => {
                    const refs = refsBySha.get(commit.sha) ?? []
                    const visibleRefs = refs.slice(0, MAX_VISIBLE_REFS)
                    const hiddenRefs = refs.length - visibleRefs.length
                    const active = commit.sha === selectedCommit
                    const selected = selectedSet.has(commit.sha)
                    return (
                      <button
                        key={commit.sha}
                        data-sha={commit.sha}
                        className={`commit-row ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}`}
                        aria-pressed={selected}
                        onClick={(event) => handleRowClick(event, commit.sha)}
                        onContextMenu={(event) => handleContextMenu(event, commit)}
                        onKeyDown={(event) => {
                          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                          event.preventDefault()
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          const live = useStore.getState()
                          if (!live.selectedCommits.includes(commit.sha)) {
                            selectCommits([commit.sha], commit.sha, commit.sha)
                          } else if (live.selectedCommit !== commit.sha) {
                            selectCommits(live.selectedCommits, commit.sha, live.selectionAnchor)
                          }
                          openMenu(rect.left + 40, rect.top + rect.height / 2)
                        }}
                        onDoubleClick={() => void openWeb(commit.sha)}
                      >
                        <span className="commit-refs-cell" title={refs.map((ref) => ref.name).join('\n')}>
                          {visibleRefs.map((ref) => (
                            <RefPill key={ref.name} item={ref} />
                          ))}
                          {hiddenRefs > 0 ? <span className="ref-pill ref-more">+{hiddenRefs}</span> : null}
                        </span>
                        <span className="commit-graph-cell" aria-hidden="true" />
                        <span className="commit-subject">
                          <span className="commit-subject-text">{commit.subject || '(no message)'}</span>
                        </span>
                        <span className="commit-author">
                          <span className="mini-avatar" style={{ background: color }}>
                            {initials(commit.author.name)}
                          </span>
                          {commit.author.name}
                        </span>
                        <span className="commit-date" title={formatDate(commit.committer.date)}>
                          {formatRelativeTime(commit.committer.date)}
                        </span>
                        <span className="commit-sha">{commit.shortSha}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="commit-load-more">
                  <Button variant="ghost" size="sm" loading={loadingMore} icon={<ArrowDownToLine size={14} />} onClick={() => void runQuery(true)}>
                    Load more commits
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="details-panel">
          {multiSelected ? (
            <div className="details-selection">
              <div className="details-selection-head">
                <strong>{selectionCount} commits selected</strong>
                <small>
                  {hasMergeSelection
                    ? 'A merge commit is selected; choose non-merge commits to cherry-pick or revert.'
                    : 'Cherry-pick replays oldest first; revert rewrites newest first.'}
                </small>
              </div>
              <div className="details-selection-actions">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<GitCommitHorizontal size={13} />}
                  disabled={hasMergeSelection}
                  onClick={() => confirmHistory('cherry-pick')}
                >
                  Cherry-pick
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Undo2 size={13} />}
                  disabled={hasMergeSelection}
                  onClick={() => confirmHistory('revert')}
                >
                  Revert
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} />}
                  onClick={() => copyText(selectedCommits.join('\n'), 'Commit SHAs')}
                >
                  Copy
                </Button>
              </div>
            </div>
          ) : null}
          {!detail ? (
            <div className="details-empty">
              <GitCommitHorizontal size={20} />
              <p>{selectionCount ? 'Select another commit to see details and changed files.' : 'Select a commit to see details and changed files.'}</p>
            </div>
          ) : (
            <>
              <div className="details-head">
                <div className="details-subject-row">
                  <h3>{detail.subject || '(no message)'}</h3>
                  <IconButton label="Open on forge" onClick={() => void openWeb(detail.sha)}>
                    <ArrowUpRight size={15} />
                  </IconButton>
                </div>
                <div className="details-refs">
                  {detailRefs.map((ref) => (
                    <Badge key={ref.name} tone={ref.kind === 'tag' ? 'purple' : ref.kind === 'remote' ? 'blue' : 'green'}>
                      {ref.name}
                    </Badge>
                  ))}
                </div>
                {detail.body ? <pre className="details-body">{detail.body}</pre> : null}
              </div>

              <div className="details-meta">
                <div>
                  <User size={13} />
                  <span>
                    <strong>{detail.author.name}</strong>
                    <small>{detail.author.email}</small>
                  </span>
                </div>
                <div>
                  <Calendar size={13} />
                  <span>
                    <strong>{formatDate(detail.author.date)}</strong>
                    <small>committed {formatRelativeTime(detail.committer.date)}</small>
                  </span>
                </div>
                <div>
                  <GitCommitHorizontal size={13} />
                  <span>
                    <strong className="mono">{detail.sha}</strong>
                    <small>
                      {detail.parents.length === 0 ? 'root commit' : `${detail.parents.length} parent${detail.parents.length === 1 ? '' : 's'}`}
                    </small>
                  </span>
                </div>
              </div>

              <div className="details-actions">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<GitBranch size={13} />}
                  onClick={() => openSingle(detail, 'branch')}
                >
                  Branch here
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Tag size={13} />}
                  onClick={() => openSingle(detail, 'tag')}
                >
                  Tag
                </Button>
                <Select
                  className="compact-select"
                  value=""
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === 'checkout') {
                      setConfirm({
                        title: 'Check out this commit?',
                        message: `This detaches HEAD at ${shortSha(detail.sha)}. Your branch will not move.`,
                        run: async () => {
                          await call('git.checkout', { repoPath: repo.path, branch: detail.sha, detach: true })
                          await useStore.getState().refreshAll(repo.path)
                          notify(`Checked out ${shortSha(detail.sha)} (detached)`, 'success')
                        }
                      })
                    } else if (value === 'cherry-pick') {
                      setConfirm({
                        title: 'Cherry-pick this commit?',
                        message: `Apply ${shortSha(detail.sha)} on top of ${currentBranch ?? 'the current HEAD'}.`,
                        run: () => runHistoryAction('cherry-pick', [detail.sha])
                      })
                    } else if (value === 'revert') {
                      setConfirm({
                        title: 'Revert this commit?',
                        message: `Create a new commit that reverses ${shortSha(detail.sha)}.`,
                        run: () => runHistoryAction('revert', [detail.sha])
                      })
                    } else if (value === 'reset') {
                      openSingle(detail, 'reset')
                    }
                  }}
                >
                  <option value="">More…</option>
                  <option value="checkout">Check out (detached)</option>
                  <option value="cherry-pick" disabled={detail.parents.length > 1}>Cherry-pick onto current branch</option>
                  <option value="revert" disabled={detail.parents.length > 1}>Revert commit</option>
                  <option value="reset">Reset current branch to here…</option>
                </Select>
              </div>

              <div className="details-files">
                <div className="details-files-head">
                  <span>
                    <History size={13} /> Changed files
                  </span>
                  <span>{diff?.files.length ?? 0}</span>
                </div>
                {diffLoading ? (
                  <div className="details-loading">
                    <Loader2 size={15} className="spin" /> Loading changes…
                  </div>
                ) : diff && diff.files.length ? (
                  <>
                    <div className="details-file-list">
                      {diff.files.map((file) => (
                        <button
                          key={file.path}
                          className={`details-file ${diffFile === file.path ? 'is-active' : ''}`}
                          onClick={() => setDiffFile(diffFile === file.path ? null : file.path)}
                        >
                          <span className="details-file-path">{file.path}</span>
                          <span className="details-file-stats">
                            {file.binary ? 'bin' : (
                              <>
                                <span className="add">+{file.additions}</span>
                                <span className="del">−{file.deletions}</span>
                              </>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                    {diffFile ? (
                      <div className="details-diff">
                        <div className="details-diff-head">
                          <span>{diffFile}</span>
                          <IconButton label="Show all changes" onClick={() => setDiffFile(null)}>
                            <X size={13} />
                          </IconButton>
                        </div>
                        <DiffView patch={diff?.patch ?? ''} fileFilter={diffFile} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="details-loading">No file changes.</div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      {menu ? (
        <>
          <div
            className="click-catcher"
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu(null)
            }}
          />
          <div className="dropdown commit-menu" role="menu" style={{ left: menu.left, top: menu.top, maxHeight: menu.maxHeight }}>
            <div className="dropdown-header">
              {multiSelected
                ? `${selectionCount} commits selected`
                : activeCommit
                  ? `${shortSha(activeCommit.sha)} · ${activeCommit.subject || '(no message)'}`
                  : selectedCommit
                    ? shortSha(selectedCommit)
                    : 'Commit'}
            </div>
            {menuEntries.map((entry) =>
              entry.kind === 'separator' ? (
                <div className="commit-menu-sep" key={entry.id} />
              ) : (
                <button
                  key={entry.id}
                  role="menuitem"
                  className={entry.danger ? 'is-danger' : ''}
                  disabled={entry.disabled}
                  onClick={() => {
                    setMenu(null)
                    entry.run()
                  }}
                >
                  {entry.icon}
                  <span>{entry.label}</span>
                </button>
              )
            )}
            {hasMergeSelection ? (
              <p className="commit-menu-note">Merge commits can’t be cherry-picked or reverted here.</p>
            ) : null}
          </div>
        </>
      ) : null}

      <Modal
        open={branchModal}
        title="Create branch at commit"
        subtitle={branchTarget ? `${shortSha(branchTarget.sha)} · ${branchTarget.subject}` : undefined}
        onClose={() => setBranchModal(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBranchModal(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void createBranch()}>Create branch</Button>
          </>
        }
      >
        <Field label="Branch name">
          <TextInput value={formName} onChange={(event) => setFormName(event.target.value)} placeholder="feature/my-branch" autoFocus />
        </Field>
        <label className="checkbox-row">
          <input type="checkbox" checked={checkoutNew} onChange={(event) => setCheckoutNew(event.target.checked)} />
          Check out the new branch
        </label>
      </Modal>

      <Modal
        open={tagModal}
        title="Create tag at commit"
        subtitle={tagTarget ? `${shortSha(tagTarget.sha)} · ${tagTarget.subject}` : undefined}
        onClose={() => setTagModal(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTagModal(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void createTag()}>Create tag</Button>
          </>
        }
      >
        <Field label="Tag name">
          <TextInput value={formName} onChange={(event) => setFormName(event.target.value)} placeholder="v1.0.0" autoFocus />
        </Field>
        <Field label="Message" hint="Annotated tag message (optional)">
          <TextInput value={formMessage} onChange={(event) => setFormMessage(event.target.value)} placeholder="Release 1.0.0" />
        </Field>
      </Modal>

      <Modal
        open={resetModal}
        title="Reset current branch"
        subtitle={resetTarget ? `Move ${currentBranch ?? 'HEAD'} to ${shortSha(resetTarget.sha)}` : undefined}
        onClose={() => setResetModal(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetModal(false)}>Cancel</Button>
            <Button variant={resetMode === 'hard' ? 'danger' : 'primary'} loading={busy} onClick={() => void resetTo()}>
              Reset {resetMode}
            </Button>
          </>
        }
      >
        <Field label="Reset mode">
          <Select value={resetMode} onChange={(event) => setResetMode(event.target.value as typeof resetMode)}>
            <option value="soft">Soft — keep changes staged</option>
            <option value="mixed">Mixed — keep changes unstaged</option>
            <option value="hard">Hard — discard all working changes</option>
          </Select>
        </Field>
        {resetMode === 'hard' ? <p className="danger-note">Hard reset discards uncommitted changes and cannot be undone.</p> : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel="Continue"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return
          setBusy(true)
          void confirm
            .run()
            .then(() => setConfirm(null))
            .catch((error) => notifyError(error))
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

function RefPill({ item }: { item: ClassifiedRef }) {
  const Icon = item.kind === 'tag' ? Tag : item.kind === 'remote' ? Cloud : item.kind === 'head' ? CircleDot : GitBranch
  return (
    <span className={`ref-pill ref-${item.kind}${item.current ? ' is-current' : ''}`} title={item.name}>
      <Icon size={9} />
      <span className="ref-pill-name">{item.name}</span>
    </span>
  )
}
