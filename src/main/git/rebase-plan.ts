import type { Commit, RebaseAction, RebaseTodoItem } from '@shared/types'

/**
 * Pure rules for the interactive rebase planner.
 *
 * The renderer never sends git arguments directly: it sends a commit list plus
 * one action per commit, and these helpers turn that into validated todo
 * entries. Keeping this module free of Node imports lets the planner rules be
 * unit tested on their own.
 */

export const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

export const MAX_REBASE_COMMITS = 500

export interface RebaseTodoEntry {
  action: RebaseAction
  sha: string
  subject: string
  message?: string
}

export interface RebaseTodoLine {
  action: RebaseAction
  sha: string
  subject: string
}

export function normalizeRebaseTarget(value: string): string {
  const onto = value.trim()
  if (!onto) throw new Error('Choose a commit or branch to rebase onto')
  if (onto.length > 240) throw new Error('Invalid rebase base')
  if (onto.startsWith('-')) throw new Error('Invalid rebase base')
  // Reject argv-unsafe and revision-range syntax. Everything else is left to
  // `git rev-parse`, which accepts characters that `git check-ref-format` allows
  // in branch names (for example "#", "+", "%", "&", ";" and "|").
  if (/[\s:?*[\]\\\x00-\x1f\x7f]/.test(onto)) throw new Error('Invalid rebase base')
  if (onto.includes('..') || onto.includes('@{')) throw new Error('Invalid rebase base')
  return onto
}

export function parseRebaseTodoItems(value: unknown): RebaseTodoItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('The rebase plan is empty')
  if (value.length > MAX_REBASE_COMMITS) throw new Error('The rebase plan has too many commits')
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid rebase plan item')
    const item = raw as Record<string, unknown>
    const sha = typeof item.sha === 'string' ? item.sha.trim() : ''
    // Full object names only: a short sha can never match the freshly read
    // commit list, so accepting one would only produce a confusing reload error.
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
      throw new Error('Invalid commit in the rebase plan')
    }
    if (typeof item.action !== 'string' || !REBASE_ACTIONS.includes(item.action as RebaseAction)) {
      throw new Error('Invalid rebase action')
    }
    const message = item.message === undefined || item.message === null ? undefined : item.message
    if (message !== undefined && typeof message !== 'string') throw new Error('Rebase message must be text')
    if (message !== undefined && message.length > 20_000) throw new Error('Rebase message is too long')
    return { sha, action: item.action as RebaseAction, message }
  })
}

export function assertRebasePlan(commits: Commit[], items: RebaseTodoItem[]): RebaseTodoEntry[] {
  if (!commits.length) throw new Error('There are no commits to rebase')
  if (items.length !== commits.length) {
    throw new Error('The commit list changed. Reload the rebase plan and try again.')
  }

  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const seen = new Set<string>()
  const entries = items.map((item) => {
    const commit = bySha.get(item.sha)
    if (!commit) throw new Error('The commit list changed. Reload the rebase plan and try again.')
    if (seen.has(item.sha)) throw new Error('A commit appears twice in the rebase plan')
    seen.add(item.sha)
    if (commit.parents.length > 1) {
      throw new Error(`Interactive rebase cannot replay merge commit ${commit.shortSha}`)
    }
    if (item.action === 'reword') {
      const message = item.message?.trim()
      if (!message) throw new Error(`Enter a new message for ${commit.shortSha}`)
      return { action: item.action, sha: commit.sha, subject: commit.subject, message }
    }
    return { action: item.action, sha: commit.sha, subject: commit.subject }
  })

  let kept = 0
  for (const entry of entries) {
    if (entry.action === 'drop') continue
    if ((entry.action === 'squash' || entry.action === 'fixup') && kept === 0) {
      throw new Error('The first kept commit must be picked or reworded')
    }
    kept += 1
  }

  return entries
}

/**
 * Rewords use git's native `reword` action. The replacement message is keyed by
 * the full commit sha and written by the controlled GIT_EDITOR script, so a
 * skipped or emptied commit can never make the editor rewrite another commit.
 */
export function buildRebaseTodoLines(entries: RebaseTodoEntry[]): RebaseTodoLine[] {
  return entries.map((entry) => ({ action: entry.action, sha: entry.sha, subject: entry.subject }))
}

export function rewordMessages(entries: RebaseTodoEntry[]): Array<{ sha: string; message: string }> {
  return entries
    .filter((entry) => entry.action === 'reword')
    .map((entry) => ({ sha: entry.sha, message: entry.message ?? '' }))
}

const COMMENT_CHARS = [';', '!', '%', '@', '|', '+', '=', '>', '$', '&', '^', '~']

/**
 * Reword messages are cleaned up by git's `--cleanup=strip`, which removes lines
 * beginning with `core.commentChar` (default `#`). Pick a comment character that
 * does not start any line the user wrote, otherwise a subject such as
 * "#123 fix login" would be deleted or moved into the body.
 */
export function chooseCommentChar(messages: string[]): string {
  const used = new Set<string>()
  for (const message of messages) {
    for (const line of message.split(/\r?\n/)) {
      const first = line.charAt(0)
      if (first) used.add(first)
    }
  }
  const char = COMMENT_CHARS.find((candidate) => !used.has(candidate))
  if (!char) throw new Error('Could not choose a safe comment character for the reword messages')
  return char
}

export function sanitizeTodoSubject(subject: string): string {
  return subject.replace(/[\r\n\x00]+/g, ' ').slice(0, 400)
}
