import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CircleDot, Play, RefreshCw, Rocket, Timer } from 'lucide-react'
import type { ActionRun, ActionWorkflow } from '@shared/types'
import { providerCapabilities } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { formatRelativeTime } from '../lib/format'
import { Badge, Button, EmptyState, Field, Modal, Select, TextArea, TextInput, Spinner } from '../components/ui'

export function ActionsView() {
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const status = useStore((state) => state.status)
  const config = useStore((state) => state.config)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const setView = useStore((state) => state.setView)
  const [workflows, setWorkflows] = useState<ActionWorkflow[]>([])
  const [runs, setRuns] = useState<ActionRun[]>([])
  const [nextPage, setNextPage] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [workflowId, setWorkflowId] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [ref, setRef] = useState('')
  const [inputs, setInputs] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const account = useMemo(
    () => config?.integrations.find((item) => item.id === detection.accountId),
    [config?.integrations, detection.accountId]
  )
  const ready = Boolean(account && detection.owner && detection.repo)
  const caps = detection.capabilities?.actions ?? (account ? providerCapabilities(account.provider).actions : undefined)
  // Only the newest request may write state, so a slow page or an old workflow
  // cannot replace a newer selection.
  const requestGeneration = useRef(0)

  const load = useCallback(async (page?: string, background = false): Promise<void> => {
    if (!account || !detection.owner || !detection.repo) return
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    const appending = Boolean(page)
    if (appending) {
      setLoadingMore(true)
      setLoading(false)
    } else if (!background) {
      setLoading(true)
      setLoadingMore(false)
    }
    try {
      if (appending) {
        const runResult = await call('provider.runs', {
          accountId: account.id,
          owner: detection.owner,
          repo: detection.repo,
          workflowId: workflowId || undefined,
          page
        })
        if (generation !== requestGeneration.current) return
        setRuns((previous) => mergeRuns(previous, runResult.items))
        // A background poll only refreshes the first page; it must not rewind
        // the paging cursor for pages the user already loaded.
        if (!background) {
          setNextPage(runResult.nextPage)
          setHasMore(runResult.hasMore && Boolean(runResult.nextPage))
        }
        setUnsupported(Boolean(runResult.unsupported))
      } else {
        const [workflowResult, runResult] = await Promise.all([
          call('provider.workflows', {
            accountId: account.id,
            owner: detection.owner,
            repo: detection.repo
          }),
          call('provider.runs', {
            accountId: account.id,
            owner: detection.owner,
            repo: detection.repo,
            workflowId: workflowId || undefined
          })
        ])
        if (generation !== requestGeneration.current) return
        setWorkflows(workflowResult.items)
        // A background poll refreshes the first page without discarding pages
        // the user has already loaded.
        setRuns((previous) => (background ? mergeRuns(runResult.items, previous) : runResult.items))
        if (!background) {
          setNextPage(runResult.nextPage)
          setHasMore(runResult.hasMore && Boolean(runResult.nextPage))
        }
        setUnsupported(Boolean(runResult.unsupported))
        if (!workflowId && workflowResult.items.length === 1) setWorkflowId(workflowResult.items[0].id)
      }
      setFailed(false)
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setFailed(true)
      if (!background) notifyError(error)
    } finally {
      // Clear this request's own flag even when a newer request superseded it,
      // otherwise a poll that interrupts "Load more" leaves the button disabled.
      if (appending || background) setLoadingMore(false)
      if (!background) setLoading(false)
    }
  }, [account, detection.owner, detection.repo, notifyError, workflowId])

  useEffect(() => {
    setRuns([])
    setNextPage(undefined)
    setHasMore(false)
    setLoadingMore(false)
    void load()
  }, [load])

  useEffect(() => {
    if (runOpen && !ref) setRef(status?.branch ?? '')
  }, [runOpen, ref, status?.branch])

  useEffect(() => {
    if (!autoRefresh || !ready || !account) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(undefined, true)
    }, 20_000)
    return () => window.clearInterval(timer)
  }, [account, autoRefresh, load, ready])

  if (!repo) return null

  if (!ready) {
    return (
      <div className="view actions-view">
        <EmptyState
          icon={<Rocket size={22} />}
          title="Connect a forge to see pipelines"
          description="Commit87 reads GitHub Actions, GitLab CI, Bitbucket Pipelines and Gitea Actions from the forge API. Connect an account and map it to this repository."
          action={<Button size="sm" variant="primary" onClick={() => setView('settings')}>Open integrations</Button>}
        />
      </div>
    )
  }

  const trigger = async (): Promise<void> => {
    if (!account) return
    if (!caps?.dispatch) {
      notify('This provider does not support dispatching workflows from Commit87', 'info')
      return
    }
    if (!ref.trim()) {
      notify('A branch or ref is required', 'info')
      return
    }
    let parsed: Record<string, string> | undefined
    if (caps.inputs && inputs.trim()) {
      try {
        const value = JSON.parse(inputs) as Record<string, unknown>
        parsed = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
      } catch {
        notify('Inputs must be a JSON object', 'error')
        return
      }
    }
    setBusy(true)
    try {
      await call('provider.triggerAction', {
        accountId: account.id,
        owner: detection.owner!,
        repo: detection.repo!,
        workflowId: workflowId || workflows[0]?.id,
        ref: ref.trim(),
        inputs: parsed
      })
      notify('Workflow dispatched', 'success')
      setRunOpen(false)
      setInputs('')
      setTimeout(() => void load(), 2500)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view actions-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <CircleDot size={17} />
          <h2>Pipelines & actions</h2>
          <Badge tone="neutral">{runs.length} runs</Badge>
          <Badge tone="blue">{detection.provider}</Badge>
        </div>
        <div className="toolbar-actions">
          <Select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} className="compact-select">
            <option value="">All workflows</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))}
          </Select>
          <label className="checkbox-row compact">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <Timer size={12} /> Auto
          </label>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => setRunOpen(true)} disabled={!caps?.dispatch || (workflows.length === 0 && detection.provider === 'github')}>
            Run workflow
          </Button>
        </div>
      </div>

      <div className="actions-layout">
        <aside className="workflow-panel">
          <div className="workflow-head">
            <span>Workflows</span>
            <Badge tone="outline">{workflows.length}</Badge>
          </div>
          <button className={`workflow-item ${workflowId === '' ? 'is-active' : ''}`} onClick={() => setWorkflowId('')}>
            <span className="workflow-dot" />
            <span>All workflows</span>
          </button>
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={`workflow-item ${workflowId === workflow.id ? 'is-active' : ''}`}
              onClick={() => setWorkflowId(workflow.id)}
              title={workflow.path}
            >
              <span className={`workflow-dot ${workflow.disabled ? 'is-disabled' : ''}`} />
              <span>{workflow.name}</span>
              {workflow.disabled ? <Badge tone="amber">off</Badge> : null}
            </button>
          ))}
          {workflows.length === 0 ? <div className="workflow-empty">No workflow files detected.</div> : null}
        </aside>

        <div className="runs-panel">
          {runs.length === 0 && !loading ? (
            unsupported ? (
              <EmptyState
                icon={<CircleDot size={22} />}
                title="Actions are unavailable"
                description="This repository does not expose Actions task runs. Check that Actions is enabled for it, or open the forge to inspect pipelines."
                action={<Button size="sm" variant="outline" onClick={() => void load()}>Reload</Button>}
              />
            ) : failed ? (
              <EmptyState
                icon={<CircleDot size={22} />}
                title="Could not load pipeline runs"
                description="The forge request failed. Check the account token and try again."
                action={<Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>}
              />
            ) : (
              <EmptyState
                icon={<CircleDot size={22} />}
                title="No pipeline runs"
                description="Runs appear here after pushes, pull requests or manual dispatches."
                action={<Button size="sm" variant="outline" onClick={() => void load()}>Reload</Button>}
              />
            )
          ) : (
            <div className="run-list">
              {runs.map((run) => (
                <article className="run-card" key={run.id}>
                  <span className={`run-status ${statusClass(run.status, run.conclusion)}`}>
                    {run.status === 'in_progress' || run.status === 'queued' ? <Spinner size={12} /> : <span className="run-dot" />}
                  </span>
                  <div className="run-main">
                    <div className="run-title">
                      <strong>{run.workflowName}</strong>
                      {run.number ? <span className="run-number">#{run.number}</span> : null}
                      <Badge tone={conclusionTone(run.conclusion)}>{run.conclusion ?? run.status}</Badge>
                    </div>
                    <div className="run-meta">
                      <span>{run.branch || '—'}</span>
                      {run.sha ? <span className="mono">{run.sha.slice(0, 8)}</span> : null}
                      <span>{run.event}</span>
                      {run.actor ? <span>by {run.actor}</span> : null}
                      <span>{formatRelativeTime(run.createdAt)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowUpRight size={13} />}
                    onClick={() => run.webUrl && void call('app.openExternal', { url: run.webUrl }).catch(notifyError)}
                    disabled={!run.webUrl}
                  >
                    Logs
                  </Button>
                </article>
              ))}
              {hasMore ? (
                <div className="list-load-more">
                  <Button size="sm" variant="outline" loading={loadingMore} onClick={() => void load(nextPage)}>
                    Load more runs
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={runOpen}
        title="Run workflow"
        subtitle={`${detection.owner}/${detection.repo}`}
        onClose={() => setRunOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} icon={<Play size={13} />} onClick={() => void trigger()}>
              Dispatch
            </Button>
          </>
        }
      >
        {workflows.length > 1 ? (
          <Field label="Workflow">
            <Select value={workflowId || workflows[0]?.id || ''} onChange={(event) => setWorkflowId(event.target.value)}>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Branch or ref" hint="The workflow definition is read from this ref.">
          <TextInput value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" autoFocus />
        </Field>
        {caps?.inputs ? (
          <Field label="Inputs (JSON)" hint="Optional workflow_dispatch inputs, passed as key/value strings.">
            <TextArea value={inputs} onChange={(event) => setInputs(event.target.value)} rows={3} placeholder={'{"environment":"staging"}'} />
          </Field>
        ) : null}
        {detection.provider === 'bitbucket' ? <p className="muted">Bitbucket Pipelines starts the pipeline defined for this branch.</p> : null}
        {detection.provider === 'gitea' && workflows.length === 0 ? <p className="muted">No workflow files were found in .gitea/workflows or .github/workflows.</p> : null}
      </Modal>
    </div>
  )
}

function statusClass(status: string, conclusion: string | null): string {
  if (status === 'in_progress' || status === 'queued' || status === 'pending') return 'is-running'
  if (conclusion === 'success') return 'is-success'
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'is-failure'
  return 'is-neutral'
}

function conclusionTone(conclusion: string | null): 'green' | 'red' | 'amber' | 'neutral' | 'blue' {
  if (conclusion === 'success') return 'green'
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'red'
  if (conclusion === 'skipped') return 'neutral'
  return 'blue'
}

function mergeRuns(existing: ActionRun[], incoming: ActionRun[]): ActionRun[] {
  const seen = new Set(existing.map((run) => run.id))
  return [...existing, ...incoming.filter((run) => !seen.has(run.id))]
}
