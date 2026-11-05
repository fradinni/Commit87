import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Commit, RebasePlan, RebasePlanInput, RebaseResult } from '@shared/types'
import { buildIdentityEnv, runGit, shellQuote, tryRunGit } from './runner'
import type { GitAuthContext } from './repo'
import { getOperationState, getStatus, resolveRepo } from './repo'
import { parseLog } from './parsers'
import {
  MAX_REBASE_COMMITS,
  assertRebasePlan,
  buildRebaseTodoLines,
  chooseCommentChar,
  normalizeRebaseTarget,
  parseRebaseTodoItems,
  rewordMessages,
  sanitizeTodoSubject
} from './rebase-plan'
import type { RebaseTodoEntry } from './rebase-plan'

/**
 * Interactive rebase bridge.
 *
 * Git has no machine-readable interface for editing its todo list, so the
 * bridge installs two small POSIX shell scripts for the lifetime of one rebase:
 *
 * - the sequence editor copies the todo file prepared by the planner, so git
 *   never opens an external editor for the list;
 * - the message editor replaces the message of a native `reword` action. It
 *   identifies the commit from the last line of git's own `rebase-merge/done`
 *   file and reads `messages/<sha>.txt`. A skipped or emptied commit never
 *   invokes the editor, so it can never rewrite a different commit.
 *
 * The todo file and scripts live under <git-dir>/gitgrove/rebase, which keeps
 * them across a conflict stop and an app restart but out of the working tree.
 * They are removed as soon as the rebase is no longer in progress.
 */

const REBASE_STATE_DIR = ['gitgrove', 'rebase'] as const
const LOG_FORMAT =
  '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s%x1f%b%x1e'

// Deterministic semantics regardless of the user's rebase config.
const REBASE_CONFIG = [
  '-c',
  'rebase.autoSquash=false',
  '-c',
  'rebase.autoStash=false',
  '-c',
  'rebase.updateRefs=false',
  '-c',
  'rebase.missingCommitsCheck=ignore'
]

export async function getRebasePlan(repoPath: string, ontoValue: string): Promise<RebasePlan> {
  const onto = normalizeRebaseTarget(ontoValue)
  const repo = await resolveRepo(repoPath)
  if (repo.isBare) throw new Error('Interactive rebase needs a working tree')
  if (repo.state !== 'clean') throw new Error('Finish or abort the current git operation first')

  const upstreamSha = await resolveCommit(repo.path, onto)
  const commits = await readRangeCommits(repo.path, upstreamSha)
  rejectMergeCommits(commits)
  const upstream = await runGit(['log', '-1', '--format=%s', upstreamSha], { cwd: repo.path })

  return {
    onto,
    upstreamSha,
    upstreamSubject: upstream.stdout.trim() || null,
    branch: repo.currentBranch,
    detached: repo.detached,
    commits
  }
}

export async function rebaseInteractive(input: RebasePlanInput, ctx: GitAuthContext): Promise<RebaseResult> {
  const onto = normalizeRebaseTarget(input.onto)
  const repo = await resolveRepo(input.repoPath)
  if (repo.isBare) throw new Error('Interactive rebase needs a working tree')
  if (repo.state !== 'clean') throw new Error('Finish or abort the current git operation first')

  const status = await getStatus(repo.path)
  if (status.files.some((file) => file.stage !== 'untracked')) {
    throw new Error('Commit or stash tracked changes before starting an interactive rebase')
  }

  const upstreamSha = await resolveCommit(repo.path, onto)
  const commits = await readRangeCommits(repo.path, upstreamSha)
  rejectMergeCommits(commits)
  const entries = assertRebasePlan(commits, parseRebaseTodoItems(input.items))

  const identity = buildIdentityEnv(ctx.identity)
  try {
    const session = await prepareSession(repo.gitDir, entries)
    const commentChar = chooseCommentChar([
      ...rewordMessages(entries).map((item) => item.message),
      ...commits.map((commit) => `${commit.subject}\n${commit.body}`)
    ])
    const result = await runGit(
      [
        ...identity.args,
        ...REBASE_CONFIG,
        '-c',
        `core.commentChar=${commentChar}`,
        'rebase',
        '--interactive',
        onto
      ],
      {
        cwd: repo.path,
        env: {
          ...identity.env,
          GIT_SEQUENCE_EDITOR: session.sequenceEditor,
          GIT_EDITOR: session.messageEditor
        },
        allowFailure: true,
        timeoutMs: 10 * 60_000
      }
    )
    return {
      output: `${result.stdout}${result.stderr}`.trim(),
      exitCode: result.exitCode,
      inProgress: (await getOperationState(repo.path)) === 'rebasing'
    }
  } finally {
    // Never delete the session while git may still need the scripts. Re-check
    // instead of trusting a flag, because runGit can also throw on timeout.
    await cleanupRebaseSessionIfIdle(repo.path)
  }
}

/**
 * Environment for `rebase --continue` and `rebase --skip`: later rewords still
 * need the message editor after a conflict stop or an app restart.
 */
export async function rebaseEditorEnv(repoPath: string): Promise<NodeJS.ProcessEnv> {
  const gitDir = await getGitDir(repoPath)
  if (!gitDir) return {}
  const script = path.join(sessionRoot(gitDir), 'edit-message.sh')
  try {
    await fs.access(script)
  } catch {
    return {}
  }
  return { GIT_EDITOR: quoteForGitShell(script) }
}

export async function cleanupRebaseSession(repoPath: string): Promise<void> {
  const gitDir = await getGitDir(repoPath)
  if (!gitDir) return
  await fs.rm(sessionRoot(gitDir), { recursive: true, force: true })
}

/**
 * Remove the bridge files once a Continue/Skip/Abort has finished the rebase.
 * While `rebase-merge` still exists the session must stay for later rewords.
 */
export async function cleanupRebaseSessionIfIdle(repoPath: string): Promise<void> {
  try {
    if ((await getOperationState(repoPath)) === 'rebasing') return
  } catch {
    return
  }
  await cleanupRebaseSession(repoPath)
}

async function resolveCommit(repoPath: string, onto: string): Promise<string> {
  const result = await tryRunGit(['rev-parse', '--verify', '--quiet', `${onto}^{commit}`], { cwd: repoPath })
  if (!result || result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`Unknown rebase base: ${onto}`)
  }
  return result.stdout.trim()
}

async function readRangeCommits(repoPath: string, upstreamSha: string): Promise<Commit[]> {
  const count = await runGit(['rev-list', '--count', `${upstreamSha}..HEAD`], { cwd: repoPath })
  const total = Number.parseInt(count.stdout.trim(), 10)
  if (Number.isFinite(total) && total > MAX_REBASE_COMMITS) {
    throw new Error(
      `This range has ${total} commits. Interactive rebase is limited to ${MAX_REBASE_COMMITS} commits.`
    )
  }
  const raw = await runGit(
    ['log', '--reverse', '--topo-order', LOG_FORMAT, `${upstreamSha}..HEAD`, '--'],
    { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 }
  )
  return parseLog(raw.stdout)
}

function rejectMergeCommits(commits: Commit[]): void {
  const merge = commits.find((commit) => commit.parents.length > 1)
  if (merge) {
    throw new Error(`Interactive rebase is not available for a range with merge commits (${merge.shortSha})`)
  }
}

interface RebaseSession {
  dir: string
  sequenceEditor: string
  messageEditor: string
}

async function prepareSession(gitDir: string, entries: RebaseTodoEntry[]): Promise<RebaseSession> {
  const dir = sessionRoot(gitDir)
  if (/[\r\n\x00]/.test(dir)) throw new Error('The repository path contains unsupported characters')
  await fs.rm(dir, { recursive: true, force: true })
  const messagesDir = path.join(dir, 'messages')
  await fs.mkdir(messagesDir, { recursive: true })

  const todoPath = path.join(dir, 'todo')
  const sequenceEditorScript = path.join(dir, 'sequence-editor.sh')
  const messageEditorScript = path.join(dir, 'edit-message.sh')
  const donePath = path.join(gitDir, 'rebase-merge', 'done')

  const todo = buildRebaseTodoLines(entries).map(
    (line) => `${line.action} ${line.sha} ${sanitizeTodoSubject(line.subject)}`
  )
  await fs.writeFile(todoPath, `${todo.join('\n')}\n`, 'utf8')

  for (const reword of rewordMessages(entries)) {
    await fs.writeFile(path.join(messagesDir, `${reword.sha}.txt`), `${reword.message}\n`, 'utf8')
  }

  await writeScript(
    sequenceEditorScript,
    `#!/bin/sh
# GitGrove: install the prepared interactive rebase todo list.
cat ${quoteForGitShell(todoPath)} > "$1"
`
  )
  await writeScript(
    messageEditorScript,
    `#!/bin/sh
# GitGrove: install a reword message supplied by the planner.
# The last line of git's done file names the commit git is rewording.
done=${quoteForGitShell(donePath)}
messages=${quoteForGitShell(messagesDir)}
last=""
if [ -f "$done" ]; then
  last=$(tail -n 1 "$done")
fi
case "$last" in
  reword\\ *)
    sha=\${last#reword }
    sha=\${sha%% *}
    slot="$messages/$sha.txt"
    if [ -f "$slot" ]; then
      cat "$slot" > "$1"
    fi
    ;;
esac
exit 0
`
  )

  return {
    dir,
    sequenceEditor: quoteForGitShell(sequenceEditorScript),
    messageEditor: quoteForGitShell(messageEditorScript)
  }
}

async function writeScript(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o755 })
  await fs.chmod(file, 0o755)
}

async function getGitDir(repoPath: string): Promise<string | null> {
  const result = await tryRunGit(['rev-parse', '--absolute-git-dir'], { cwd: repoPath })
  if (!result || result.exitCode !== 0 || !result.stdout.trim()) return null
  return result.stdout.trim()
}

function sessionRoot(gitDir: string): string {
  return path.join(gitDir, ...REBASE_STATE_DIR)
}

/**
 * Git runs editor commands through a shell, so the only value that ever needs
 * quoting is an app-controlled absolute path. User text never reaches this
 * function: messages and subjects are written to data files instead.
 */
export function quoteForGitShell(value: string): string {
  const normalized = process.platform === 'win32' ? value.replace(/\\/g, '/') : value
  return shellQuote(normalized)
}
