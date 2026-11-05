import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  Calendar,
  CircleDot,
  Cloud,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  RotateCcw,
  Search,
  Tag,
  User,
  X
} from 'lucide-react'
import type { Commit, DiffResult } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call } from '../lib/ipc'
import { buildGraph, classifyRefs, GRAPH_PADDING, LANE_GAP } from '../lib/graph'
import type { ClassifiedRef } from '../lib/graph'
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

export function GraphView() {
  const repo = useStore((state) => state.currentRepo)
  const commits = useStore((state) => state.commits)
  const branches = useStore((state) => state.branches)
  const tags = useStore((state) => state.tags)
  const config = useStore((state) => state.config)
  const detection = useStore((state) => state.detection)
  const selectedCommit = useStore((state) => state.selectedCommit)
  const selectCommit = useStore((state) => state.selectCommit)
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
  const [tagModal, setTagModal] = useState(false)
  const [formName, setFormName] = useState('')
  const [formMessage, setFormMessage] = useState('')
  const [checkoutNew, setCheckoutNew] = useState(true)
  const [resetModal, setResetModal] = useState(false)
  const [resetMode, setResetMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => Promise<void> } | null>(null)
  const [busy, setBusy] = useState(false)

  const layout = useMemo(() => buildGraph(commits, ROW_HEIGHT), [commits])
  const graphStyle = useMemo<GraphColumnStyle>(
    () => ({ '--graph-w': `${layout.width}px`, '--refs-w': `${REFS_WIDTH}px` }),
    [layout.width]
  )
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
          selectCommit(fresh[0]?.sha ?? null)
        }
      } catch (error) {
        notifyError(error)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [branch, commits, config?.maxCommits, notifyError, query, repo, selectCommit]
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
        if (!cancelled) notifyError(error)
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [notifyError, repo?.path, selectedCommit])

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

  const createBranch = async (): Promise<void> => {
    if (!formName.trim() || !detail) return
    setBusy(true)
    try {
      await call('git.createBranch', {
        path: repo.path,
        name: formName.trim(),
        startPoint: detail.sha,
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
    if (!formName.trim() || !detail) return
    setBusy(true)
    try {
      await call('git.tagCreate', {
        repoPath: repo.path,
        name: formName.trim(),
        message: formMessage.trim() || undefined,
        commit: detail.sha,
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
    if (!detail) return
    setBusy(true)
    try {
      await call('git.reset', { repoPath: repo.path, commit: detail.sha, mode: resetMode })
      await useStore.getState().refreshAll(repo.path)
      notify(`Reset ${resetMode} to ${shortSha(detail.sha)}`, 'success')
      setResetModal(false)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const runHistoryAction = async (action: 'cherry-pick' | 'revert'): Promise<void> => {
    if (!detail) return
    try {
      const result =
        action === 'cherry-pick'
          ? await call('git.cherryPick', { path: repo.path, sha: detail.sha, identityId: activeIdentity()?.id })
          : await call('git.revert', { path: repo.path, sha: detail.sha, identityId: activeIdentity()?.id })
      await useStore.getState().refreshAll(repo.path)
      notify(result.output?.trim() || (action === 'cherry-pick' ? 'Cherry-picked' : 'Reverted'), 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  const localBranches = branches.filter((item) => item.type === 'branch')

  return (
    <div className="view graph-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <GitCommitHorizontal size={17} />
          <h2>Commit graph</h2>
          <Badge tone="neutral">{commits.length} loaded</Badge>
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
            <div className="commit-scroll">
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
                      const selected = node.sha === selectedCommit
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
                            r={selected ? 5.6 : radius}
                            fill={selected ? node.color : 'var(--bg-panel)'}
                            stroke={node.color}
                            strokeWidth={selected ? 2 : 1.8}
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
                    return (
                      <button
                        key={commit.sha}
                        className={`commit-row ${commit.sha === selectedCommit ? 'is-selected' : ''}`}
                        onClick={() => selectCommit(commit.sha)}
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
          {!detail ? (
            <div className="details-empty">
              <GitCommitHorizontal size={20} />
              <p>Select a commit to see details and changed files.</p>
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
                <Button size="sm" variant="outline" icon={<GitBranch size={13} />} onClick={() => { setFormName(''); setBranchModal(true) }}>
                  Branch here
                </Button>
                <Button size="sm" variant="outline" icon={<Tag size={13} />} onClick={() => { setFormName(''); setFormMessage(''); setTagModal(true) }}>
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
                          await call('git.checkout', { repoPath: repo.path, branch: detail.sha })
                          await useStore.getState().refreshAll(repo.path)
                        }
                      })
                    } else if (value === 'cherry-pick') {
                      setConfirm({
                        title: 'Cherry-pick this commit?',
                        message: `Apply ${shortSha(detail.sha)} on top of ${currentBranch ?? 'the current HEAD'}.`,
                        run: () => runHistoryAction('cherry-pick')
                      })
                    } else if (value === 'revert') {
                      setConfirm({
                        title: 'Revert this commit?',
                        message: `Create a new commit that reverses ${shortSha(detail.sha)}.`,
                        run: () => runHistoryAction('revert')
                      })
                    } else if (value === 'reset') {
                      setResetModal(true)
                    }
                  }}
                >
                  <option value="">More…</option>
                  <option value="checkout">Check out (detached)</option>
                  <option value="cherry-pick">Cherry-pick onto current branch</option>
                  <option value="revert">Revert commit</option>
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

      <Modal
        open={branchModal}
        title="Create branch at commit"
        subtitle={detail ? `${shortSha(detail.sha)} · ${detail.subject}` : undefined}
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
        subtitle={`Move ${currentBranch ?? 'HEAD'} to ${detail ? shortSha(detail.sha) : ''}`}
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
            .then(() => {
              notify('Done', 'success')
              setConfirm(null)
            })
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
