import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Download, GitPullRequest, Plus, RefreshCw } from 'lucide-react'
import type { PullRequest } from '@shared/types'
import { providerCapabilities } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { formatRelativeTime } from '../lib/format'
import { Badge, Button, EmptyState, Field, Modal, Select, TextArea, TextInput } from '../components/ui'

export function PullsView() {
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const branches = useStore((state) => state.branches)
  const status = useStore((state) => state.status)
  const config = useStore((state) => state.config)
  const notifications = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const setView = useStore((state) => state.setView)
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const [pulls, setPulls] = useState<PullRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [nextPage, setNextPage] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)

  const account = useMemo(
    () => config?.integrations.find((item) => item.id === detection.accountId),
    [config?.integrations, detection.accountId]
  )
  const localBranches = useMemo(() => branches.filter((item) => item.type === 'branch'), [branches])
  const label = detection.provider === 'gitlab' ? 'merge request' : 'pull request'
  const caps = detection.capabilities?.pullRequests ?? (account ? providerCapabilities(account.provider).pullRequests : undefined)
  // Accumulated list for "Load more"; the store mirror may be reset by an
  // unrelated refresh, so paging reads its own copy.
  const loadedPulls = useRef<PullRequest[]>([])
  const repoPath = repo?.path
  // Only the newest request may write state; a slower response for a previous
  // filter or page must not overwrite newer results.
  const requestGeneration = useRef(0)

  const load = useCallback(async (page?: string): Promise<void> => {
    if (!repoPath || !detection.accountId || !detection.owner || !detection.repo) return
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    const appending = Boolean(page)
    if (appending) {
      setLoadingMore(true)
      setLoading(false)
    } else {
      setLoading(true)
      setLoadingMore(false)
    }
    try {
      const result = await call('provider.pullRequests', {
        accountId: detection.accountId,
        owner: detection.owner,
        repo: detection.repo,
        state,
        page
      })
      if (generation !== requestGeneration.current) return
      const next = appending ? mergePulls(loadedPulls.current, result.items) : result.items
      loadedPulls.current = next
      setPulls(next)
      setNextPage(result.nextPage)
      setHasMore(result.hasMore && Boolean(result.nextPage))
      setFailed(false)
      useStore.getState().updateTab(repoPath, { pulls: next })
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setFailed(true)
      notifyError(error)
    } finally {
      // Clear this request's own flag even when a newer request superseded it.
      if (appending) setLoadingMore(false)
      else setLoading(false)
    }
  }, [detection.accountId, detection.owner, detection.repo, notifyError, repoPath, state])

  useEffect(() => {
    loadedPulls.current = []
    setPulls([])
    setNextPage(undefined)
    setHasMore(false)
    setLoadingMore(false)
    void load()
  }, [load])

  useEffect(() => {
    if (!createOpen) return
    setSource(status?.branch ?? localBranches[0]?.shortName ?? '')
    setTarget(localBranches.find((item) => item.shortName === 'main')?.shortName ?? localBranches.find((item) => item.shortName === 'master')?.shortName ?? '')
  }, [createOpen, localBranches, status?.branch])

  if (!repo) return null

  if (!account || !detection.owner || !detection.repo) {
    return (
      <div className="view pulls-view">
        <EmptyState
          icon={<GitPullRequest size={22} />}
          title="Connect a forge to manage pull requests"
          description="Commit87 matches the repository remote to a GitHub, GitLab, Bitbucket or Gitea account. Add an account and a token in Settings."
          action={<Button variant="primary" size="sm" onClick={() => setView('settings')}>Open integrations</Button>}
        />
      </div>
    )
  }

  const create = async (): Promise<void> => {
    if (!title.trim() || !source || !target) {
      notifications('Title, source and target branches are required', 'info')
      return
    }
    setBusy(true)
    try {
      const pull = await call('provider.createPullRequest', {
        accountId: account.id,
        owner: detection.owner!,
        repo: detection.repo!,
        input: { title: title.trim(), sourceBranch: source, targetBranch: target, body, draft }
      })
      notifications(`${label} #${pull.number} created`, 'success')
      setCreateOpen(false)
      setTitle('')
      setBody('')
      setDraft(false)
      await load()
      await call('app.openExternal', { url: pull.webUrl }).catch(() => undefined)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (pull: PullRequest): Promise<void> => {
    try {
      const result = await call('provider.checkoutPullRequest', {
        path: repo.path,
        accountId: account.id,
        owner: detection.owner!,
        repo: detection.repo!,
        number: pull.number
      })
      await useStore.getState().refreshAll(repo.path)
      notifications(`Checked out ${result.branch}`, 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <div className="view pulls-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <GitPullRequest size={17} />
          <h2>{detection.provider === 'gitlab' ? 'Merge requests' : 'Pull requests'}</h2>
          <Badge tone="blue">{detection.owner}/{detection.repo}</Badge>
        </div>
        <div className="toolbar-actions">
          <div className="segmented small">
            {(['open', 'closed', 'all'] as const).map((value) => (
              <button key={value} className={state === value ? 'is-active' : ''} onClick={() => setState(value)}>
                {value}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
            New {label}
          </Button>
        </div>
      </div>

      {pulls.length === 0 && !loading ? (
        failed ? (
          <EmptyState
            icon={<GitPullRequest size={22} />}
            title={`Could not load ${label}s`}
            description="The forge request failed. Check the account token and try again."
            action={<Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>}
          />
        ) : (
          <EmptyState
            icon={<GitPullRequest size={22} />}
            title={`No ${label}s`}
            description={`There are no ${state === 'all' ? '' : `${state} `}${label}s for this repository, or the token cannot see them.`}
            action={<Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>Create one</Button>}
          />
        )
      ) : (
        <div className="pull-list">
          {pulls.map((pull) => (
            <article className="pull-card" key={pull.id}>
              <div className="pull-state">
                <Badge tone={pull.state === 'open' ? 'green' : pull.state === 'merged' ? 'purple' : pull.state === 'draft' ? 'neutral' : 'red'}>
                  {pull.state}
                </Badge>
              </div>
              <button className="pull-main" onClick={() => void call('app.openExternal', { url: pull.webUrl }).catch(notifyError)}>
                <span className="pull-title">
                  #{pull.number} {pull.title}
                </span>
                <span className="pull-meta">
                  <span>{pull.author}</span>
                  <span className="mono">{pull.sourceBranch} → {pull.targetBranch}</span>
                  <span>updated {formatRelativeTime(pull.updatedAt)}</span>
                  {pull.additions !== undefined ? <span className="add">+{pull.additions}</span> : null}
                  {pull.deletions !== undefined ? <span className="del">−{pull.deletions}</span> : null}
                </span>
              </button>
              <div className="pull-actions">
                {caps?.checkout ? (
                  <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void checkout(pull)}>
                    Checkout
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" icon={<ArrowUpRight size={13} />} onClick={() => void call('app.openExternal', { url: pull.webUrl }).catch(notifyError)}>
                  Open
                </Button>
              </div>
            </article>
          ))}
          {hasMore ? (
            <div className="list-load-more">
              <Button size="sm" variant="outline" loading={loadingMore} onClick={() => void load(nextPage)}>
                Load more {label}s
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <Modal
        open={createOpen}
        title={`New ${label}`}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>Create</Button>
          </>
        }
      >
        <Field label="Title">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Describe your change" autoFocus />
        </Field>
        <div className="form-grid">
          <Field label="Source branch">
            <Select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">Select…</option>
              {localBranches.map((branch) => (
                <option key={branch.name} value={branch.shortName}>{branch.shortName}</option>
              ))}
            </Select>
          </Field>
          <Field label="Target branch">
            <Select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Select…</option>
              {localBranches.map((branch) => (
                <option key={branch.name} value={branch.shortName}>{branch.shortName}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description">
          <TextArea value={body} onChange={(event) => setBody(event.target.value)} rows={5} placeholder="What changed, and why?" />
        </Field>
        <label className="checkbox-row">
          <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
          Create as draft
        </label>
      </Modal>
    </div>
  )
}

function mergePulls(existing: PullRequest[], incoming: PullRequest[]): PullRequest[] {
  const seen = new Set(existing.map((pull) => pull.id))
  return [...existing, ...incoming.filter((pull) => !seen.has(pull.id))]
}
