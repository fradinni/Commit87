import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ListTree } from 'lucide-react'
import type { Commit, RebaseAction, RebasePlan } from '@shared/types'
import { activeIdentity, useStore } from '../store'
import { call, errorMessage } from '../lib/ipc'
import { Badge, Button, EmptyState, Field, IconButton, LoadingBlock, Modal, Select, TextArea } from './ui'

interface RebaseRow {
  commit: Commit
  action: RebaseAction
  message: string
}

const REBASE_ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'drop', label: 'Drop' }
]

function shortSha(commit: Commit): string {
  return commit.shortSha || commit.sha.slice(0, 7)
}

export function RebasePlanner() {
  const rebaseOpen = useStore((state) => state.rebaseOpen)
  const rebaseOnto = useStore((state) => state.rebaseOnto)
  const closeRebase = useStore((state) => state.closeRebase)
  const repoPath = useStore((state) => state.currentRepo?.path ?? null)
  const currentRepo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const branches = useStore((state) => state.branches)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)

  const [base, setBase] = useState('')
  const [plan, setPlan] = useState<RebasePlan | null>(null)
  const [rows, setRows] = useState<RebaseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  // Pick the initial base whenever the planner is opened (or retargeted), reading fresh state
  // so a refresh of `status` while the user edits does not reset their selection.
  useEffect(() => {
    if (!rebaseOpen) return
    const state = useStore.getState()
    setBase(state.rebaseOnto ?? state.status?.upstream ?? '')
  }, [rebaseOpen, rebaseOnto])

  useEffect(() => {
    const token = ++requestRef.current
    if (!rebaseOpen || !repoPath || !base) {
      setPlan(null)
      setRows([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    setPlan(null)
    setRows([])
    call('git.rebasePlan', { repoPath, onto: base })
      .then((nextPlan) => {
        if (requestRef.current !== token) return
        setPlan(nextPlan)
        setRows(
          nextPlan.commits.map((commit) => ({
            commit,
            action: 'pick',
            message: commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject
          }))
        )
        setLoading(false)
      })
      .catch((nextError: unknown) => {
        if (requestRef.current !== token) return
        setLoading(false)
        setError(errorMessage(nextError))
      })
  }, [base, rebaseOpen, repoPath])

  const baseOptions = useMemo(() => {
    const values = branches
      .filter((branch) => branch.type === 'branch' || branch.type === 'remote')
      .map((branch) => branch.shortName)
    const unique = [...new Set(values)]
    if (base && !unique.includes(base)) unique.unshift(base)
    return unique
  }, [base, branches])

  const baseLabel = (value: string): string => {
    if (status?.upstream === value) return `${value} (upstream)`
    if (status?.branch === value || currentRepo?.currentBranch === value) return `${value} (current)`
    return value
  }

  const replayedCount = rows.filter((row) => row.action !== 'drop').length
  const branchLabel = plan?.branch ?? 'detached HEAD'
  const trackedChanges = status?.files.some((file) => file.stage !== 'untracked') ?? false
  const blockedReason = currentRepo && currentRepo.state !== 'clean'
    ? 'Finish or abort the current git operation first.'
    : trackedChanges
      ? 'Commit or stash tracked changes before starting an interactive rebase.'
      : null

  const validation = useMemo(() => {
    if (!plan || plan.commits.length === 0) {
      return { valid: false, error: null as string | null, warning: null as string | null }
    }
    if (blockedReason) {
      return { valid: false, error: blockedReason, warning: null }
    }
    let kept = false
    let dropped = 0
    for (const row of rows) {
      if (row.action === 'drop') {
        dropped += 1
        continue
      }
      if ((row.action === 'squash' || row.action === 'fixup') && !kept) {
        return { valid: false, error: 'The first kept commit must be picked or reworded.', warning: null }
      }
      if (row.action === 'reword' && !row.message.trim()) {
        return { valid: false, error: `Enter a new message for ${shortSha(row.commit)}.`, warning: null }
      }
      kept = true
    }
    const warning =
      dropped === rows.length
        ? `All commits are dropped. ${branchLabel} will move to ${plan.onto}.`
        : null
    return { valid: rows.length > 0, error: null, warning }
  }, [blockedReason, branchLabel, plan, rows])

  const updateRow = (index: number, patch: Partial<Pick<RebaseRow, 'action' | 'message'>>): void => {
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  const moveRow = (index: number, offset: number): void => {
    setRows((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [row] = next.splice(index, 1)
      if (!row) return current
      next.splice(target, 0, row)
      return next
    })
  }

  const start = async (): Promise<void> => {
    if (!plan || !repoPath || !validation.valid) return
    setBusy(true)
    setError(null)
    try {
      const result = await call('git.rebaseInteractive', {
        repoPath,
        onto: plan.onto,
        items: rows.map((row) => ({
          sha: row.commit.sha,
          action: row.action,
          message: row.action === 'reword' ? row.message : undefined
        })),
        identityId: activeIdentity()?.id
      })
      await useStore.getState().refreshAll()
      if (result.inProgress) {
        closeRebase()
        if (/\bCONFLICT\b|Could not apply/.test(result.output)) {
          notify('Rebase paused on conflicts. Resolve them, then use Continue or Abort in the status bar.', 'info')
        } else {
          notify(result.output.slice(-900) || 'Rebase paused. Use Continue or Abort in the status bar.', 'error')
        }
      } else if (result.exitCode !== 0) {
        const message = result.output || 'The interactive rebase could not start'
        setError(message)
        notify(message.slice(0, 900), 'error')
      } else {
        closeRebase()
        notify('Interactive rebase finished', 'success')
      }
    } catch (nextError) {
      setError(errorMessage(nextError))
      notifyError(nextError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={rebaseOpen}
      title="Interactive rebase"
      subtitle="Reorder, edit, squash or drop commits before they are replayed."
      onClose={closeRebase}
      width={780}
      footer={
        <>
          <Button variant="ghost" onClick={closeRebase}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!validation.valid} onClick={() => void start()}>
            Start rebase
          </Button>
        </>
      }
    >
      <div className="rebase-planner">
        <Field label="Rebase onto">
          <Select value={base} onChange={(event) => setBase(event.target.value)}>
            {!base ? <option value="">Choose a base branch</option> : null}
            {baseOptions.map((option) => (
              <option key={option} value={option}>
                {baseLabel(option)}
              </option>
            ))}
          </Select>
        </Field>

        {!repoPath ? (
          <EmptyState
            icon={<ListTree size={20} />}
            title="No repository open"
            description="Open a repository to plan a rebase."
          />
        ) : !base ? (
          <EmptyState
            icon={<ListTree size={20} />}
            title="Choose a base"
            description="Select the branch these commits should be replayed onto."
          />
        ) : loading ? (
          <LoadingBlock label="Building rebase plan…" />
        ) : plan ? (
          <>
            <div className="rebase-base">
              <Badge tone="outline">onto</Badge>
              <span className="mono">{plan.upstreamSha ? plan.upstreamSha.slice(0, 7) : plan.onto}</span>
              <span className="ellipsis">{plan.upstreamSubject ?? plan.onto}</span>
            </div>

            {plan.commits.length === 0 ? (
              <EmptyState
                icon={<ListTree size={20} />}
                title="Nothing to rebase"
                description={`${branchLabel} has no commits to replay onto ${plan.onto}.`}
              />
            ) : (
              <>
                <p className="rebase-summary">
                  Replaying {replayedCount} of {plan.commits.length} commits · {branchLabel}
                </p>
                <div className="rebase-list">
                  {rows.map((row, index) => (
                    <div key={row.commit.sha} className={`rebase-row ${row.action === 'drop' ? 'is-dropped' : ''}`}>
                      <div className="rebase-row-main">
                        <span className="mono">{shortSha(row.commit)}</span>
                        <span className="rebase-row-subject ellipsis">{row.commit.subject}</span>
                        <span className="rebase-row-meta">{row.commit.author.name}</span>
                        <Select
                          className="rebase-action"
                          aria-label={`Action for ${shortSha(row.commit)}`}
                          value={row.action}
                          onChange={(event) => updateRow(index, { action: event.target.value as RebaseAction })}
                        >
                          {REBASE_ACTIONS.map((action) => (
                            <option key={action.value} value={action.value}>
                              {action.label}
                            </option>
                          ))}
                        </Select>
                        <div className="rebase-row-actions">
                          <IconButton label="Move commit up" disabled={index === 0} onClick={() => moveRow(index, -1)}>
                            <ArrowUp size={14} />
                          </IconButton>
                          <IconButton
                            label="Move commit down"
                            disabled={index === rows.length - 1}
                            onClick={() => moveRow(index, 1)}
                          >
                            <ArrowDown size={14} />
                          </IconButton>
                        </div>
                      </div>
                      {row.action === 'reword' ? (
                        <TextArea
                          className="rebase-row-message"
                          aria-label={`New message for ${shortSha(row.commit)}`}
                          value={row.message}
                          rows={2}
                          placeholder="New commit message"
                          onChange={(event) => updateRow(index, { message: event.target.value })}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
                {validation.warning ? <p className="rebase-warning">{validation.warning}</p> : null}
                {validation.error ? <p className="rebase-error">{validation.error}</p> : null}
                {error ? <p className="rebase-error">{error}</p> : null}
              </>
            )}
          </>
        ) : error ? (
          <p className="rebase-error">{error}</p>
        ) : null}
      </div>
    </Modal>
  )
}
