import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  Calendar,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
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
import { buildGraph, graphWidth } from '../lib/graph'
import { formatDate, formatRelativeTime, initials, shortSha } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Modal, Select, TextInput, Field } from '../components/ui'
import { DiffView } from '../components/DiffView'

const ROW_HEIGHT = 36

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
  const [query, setQuery] = useState('')
  const [branch, setBranch] = useState('')
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
  const width = graphWidth(layout.laneCount)
  const tagNames = useMemo(() => new Set(tags.map((item) => item.name)), [tags])

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
        useStore.setState({ commits: next })
        if (!append) {
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
      await useStore.getState().refreshAll()
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
      await useStore.getState().refreshTags()
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
      await useStore.getState().refreshAll()
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
      await useStore.getState().refreshAll()
      notify(result.output?.trim() || (action === 'cherry-pick' ? 'Cherry-picked' : 'Reverted'), 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  const currentBranch = useStore((state) => state.status?.branch)
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
          <div className="commit-head" style={{ paddingLeft: width + 12 }}>
            <span>Description</span>
            <span>Author</span>
            <span>Date</span>
            <span>SHA</span>
          </div>
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
              <div className="commit-rows" style={{ position: 'relative' }}>
                <svg className="graph-svg" width={width} height={Math.max(commits.length * ROW_HEIGHT, 1)} aria-hidden="true">
                  {layout.edges.map((edge, index) => (
                    <path key={index} d={edge.d} stroke={edge.color} strokeWidth={1.8} fill="none" opacity={0.85} />
                  ))}
                  {layout.nodes.map((node) => (
                    <circle
                      key={node.sha}
                      cx={node.lane * 16 + 12}
                      cy={node.row * ROW_HEIGHT + ROW_HEIGHT / 2}
                      r={node.sha === selectedCommit ? 5.2 : 3.8}
                      fill={node.sha === selectedCommit ? node.color : 'var(--bg-panel)'}
                      stroke={node.color}
                      strokeWidth={2}
                    />
                  ))}
                </svg>
                {layout.rows.map(({ commit, color }) => {
                  const refs = commit.refs.slice(0, 3)
                  return (
                    <button
                      key={commit.sha}
                      className={`commit-row ${commit.sha === selectedCommit ? 'is-selected' : ''}`}
                      style={{ paddingLeft: width + 12 }}
                      onClick={() => selectCommit(commit.sha)}
                      onDoubleClick={() => void openWeb(commit.sha)}
                    >
                      <span className="commit-subject">
                        <span className="commit-dot" style={{ background: color }} />
                        <span className="commit-subject-text">{commit.subject || '(no message)'}</span>
                        <span className="commit-refs">
                          {refs.map((ref) => {
                            const isTag = tagNames.has(ref)
                            const isRemote = ref.includes('/')
                            const tone = isTag ? 'purple' : isRemote ? 'blue' : ref === 'HEAD' ? 'green' : 'green'
                            return (
                              <Badge key={ref} tone={tone}>
                                {isTag ? <Tag size={10} /> : isRemote ? <GitPullRequestArrow size={10} /> : <GitBranch size={10} />}
                                {ref}
                              </Badge>
                            )
                          })}
                          {commit.refs.length > 3 ? <Badge tone="outline">+{commit.refs.length - 3}</Badge> : null}
                        </span>
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
                  {detail.refs.map((ref) => (
                    <Badge key={ref} tone={tagNames.has(ref) ? 'purple' : ref.includes('/') ? 'blue' : 'green'}>
                      {ref}
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
                          await useStore.getState().refreshAll()
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
