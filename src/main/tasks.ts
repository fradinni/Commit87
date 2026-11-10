import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { TaskEvent, TaskHandle, TaskSnapshot, TaskSnapshotEntry } from '@shared/types'
import { assertGitBinaryUsable, getGitBinary, gitBaseArgs, redact } from './git/runner'
import { refName, relPath, revision, word } from './ipc/validate'

/** Bytes of redacted output retained per task (the snapshot tail and exit text). */
export const TASK_TAIL_BYTES = 16 * 1024
/** Longest line delivered to the renderer before it is split. */
export const TASK_LINE_BYTES = 4 * 1024
/** Finished tasks kept for a reconnecting renderer. */
export const TASK_RECENT_LIMIT = 20

export interface TaskSpec {
  kind: TaskEvent['kind']
  title: string
  args: string[]
  cwd: string
  repoPath?: string
  env?: NodeJS.ProcessEnv
  input?: string
  secrets?: Array<string | null | undefined>
  onExit?: (code: number | null, output: string) => void | Promise<void>
}

export interface TaskResult {
  code: number | null
  output: string
}

/**
 * Splits a Git stream into lines while keeping memory bounded. A line that
 * never ends (progress output without newlines, a very long path) is flushed
 * in `lineBytes` pieces instead of growing forever, and only the last
 * `tailBytes` of the task are retained for exit text and reconnection.
 */
export class TaskOutputBuffer {
  private buffer = ''
  private tailText = ''

  constructor(
    private readonly tailBytes = TASK_TAIL_BYTES,
    private readonly lineBytes = TASK_LINE_BYTES,
    private readonly sanitize: (text: string) => string = (text) => text
  ) {}

  get tail(): string {
    return this.tailText
  }

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split(/\r\n|\n|\r/)
    this.buffer = lines.pop() ?? ''
    const emitted: string[] = []
    for (const line of lines) {
      // Git progress and blank separators: keep the existing blank-line
      // behaviour instead of filling the console with empty rows.
      if (line.trim()) emitted.push(...this.record(line))
    }
    // A newline-free stream must not accumulate without limit: emit it in
    // bounded pieces so the renderer still sees progress.
    while (this.buffer.length > this.lineBytes) {
      const piece = this.takePiece()
      if (piece.trim()) emitted.push(...this.record(piece))
    }
    return emitted
  }

  /** Emit the unterminated remainder when the child closes. */
  finish(): string[] {
    const rest = this.buffer
    this.buffer = ''
    return rest.trim() ? this.record(rest) : []
  }

  /** Cut a bounded piece without splitting a surrogate pair. */
  private takePiece(): string {
    let end = this.lineBytes
    const code = this.buffer.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
    const piece = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end)
    return piece
  }

  private record(line: string): string[] {
    const text = this.sanitize(line)
    // The tail keeps the *end* of long output (what a failure usually needs);
    // every emitted line stays within the console's per-line budget, and a
    // terminated line longer than that budget is emitted as several pieces
    // rather than silently truncated.
    this.tailText = `${this.tailText}${text}\n`.slice(-this.tailBytes)
    if (text.length <= this.lineBytes) return text ? [text] : []
    const pieces: string[] = []
    let rest = text
    while (rest.length > this.lineBytes) {
      const end =
        rest.charCodeAt(this.lineBytes - 1) >= 0xd800 && rest.charCodeAt(this.lineBytes - 1) <= 0xdbff
          ? this.lineBytes - 1
          : this.lineBytes
      pieces.push(rest.slice(0, end))
      rest = rest.slice(end)
    }
    if (rest) pieces.push(rest)
    return pieces
  }
}

interface TaskRecord {
  taskId: string
  kind: TaskEvent['kind']
  title: string
  repoPath?: string
  phase: 'running' | 'end' | 'error'
  startedAt: number
  endedAt?: number
  exitCode?: number
  error?: string
  output: TaskOutputBuffer
}

export class TaskManager {
  private readonly emit: (event: TaskEvent) => void
  /** Running tasks, keyed by id, in start order. */
  private readonly running = new Map<string, TaskRecord>()
  /** Finished tasks, oldest first, capped at TASK_RECENT_LIMIT. */
  private readonly recent: TaskRecord[] = []

  constructor(emit: (event: TaskEvent) => void) {
    this.emit = emit
  }

  /** Running and recently finished tasks for a renderer that just reloaded. */
  snapshot(): TaskSnapshot {
    const entry = (record: TaskRecord): TaskSnapshotEntry => ({
      taskId: record.taskId,
      kind: record.kind,
      title: record.title,
      repoPath: record.repoPath,
      phase: record.phase,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      error: record.error,
      output: record.output.tail
    })
    return {
      running: [...this.running.values()].map(entry),
      recent: this.recent.map(entry)
    }
  }

  private rememberFinished(record: TaskRecord): void {
    this.recent.push(record)
    if (this.recent.length > TASK_RECENT_LIMIT) this.recent.splice(0, this.recent.length - TASK_RECENT_LIMIT)
  }

  start(spec: TaskSpec): TaskHandle {
    const taskId = randomUUID()
    const secrets = spec.secrets ?? []
    let finished = false

    const record: TaskRecord = {
      taskId,
      kind: spec.kind,
      // The title can contain the console command line; redact it once so the
      // reconnection snapshot cannot reintroduce a secret the live event hid.
      title: redact(spec.title, secrets),
      repoPath: spec.repoPath,
      phase: 'running',
      startedAt: Date.now(),
      output: new TaskOutputBuffer(TASK_TAIL_BYTES, TASK_LINE_BYTES, (text) => redact(text, secrets))
    }
    this.running.set(taskId, record)

    const send = (event: TaskEvent): void => {
      event.repoPath = spec.repoPath
      if (event.text) event.text = redact(event.text, secrets)
      if (event.error) event.error = redact(event.error, secrets)
      this.emit(event)
    }

    send({ taskId, kind: spec.kind, phase: 'start', text: spec.title })

    const settle = (phase: 'end' | 'error', exitCode?: number, error?: string): void => {
      record.phase = phase
      record.endedAt = Date.now()
      record.exitCode = exitCode
      record.error = error ? redact(error, secrets) : error
      this.running.delete(taskId)
      this.rememberFinished(record)
    }

    let child: ChildProcess
    try {
      const binary = getGitBinary()
      assertGitBinaryUsable(binary)
      child = spawn(binary, [...gitBaseArgs(), ...spec.args], {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...spec.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
          LC_ALL: 'C'
        },
        windowsHide: true,
        shell: false
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      settle('error', undefined, message)
      // Tell the renderer too: otherwise its task chip would stay running and
      // keep the status poll paused until a reload.
      send({ taskId, kind: spec.kind, phase: 'error', error: message })
      throw error
    }

    const flush = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      for (const line of record.output.push(chunk)) {
        send({ taskId, kind: spec.kind, phase: 'output', text: line, stream })
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => flush(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: string) => flush(chunk, 'stderr'))

    child.on('error', (error) => {
      if (finished) return
      finished = true
      settle('error', undefined, error.message)
      send({ taskId, kind: spec.kind, phase: 'error', error: error.message })
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      for (const line of record.output.finish()) {
        send({ taskId, kind: spec.kind, phase: 'output', text: line, stream: 'stdout' })
      }
      void (async () => {
        // Post-run bookkeeping (such as recording a clone in the recent list)
        // must land before the completion event, so the renderer does not
        // refresh lists that are not written yet.
        try {
          await spec.onExit?.(code, record.output.tail)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          console.warn(`[commit87] task bookkeeping failed after "${spec.title}": ${detail}`)
        }
        const tail = record.output.tail.slice(-4000)
        if (code !== 0) {
          const error = spec.kind === 'console' ? 'Command failed' : `${spec.title} failed (exit code ${code ?? 'unknown'})`
          settle('error', code ?? undefined, error)
          send({
            taskId,
            kind: spec.kind,
            phase: 'error',
            exitCode: code ?? undefined,
            error,
            text: tail
          })
        } else {
          settle('end', 0)
          send({ taskId, kind: spec.kind, phase: 'end', exitCode: 0, text: tail })
        }
      })()
    })

    if (spec.input !== undefined) child.stdin?.end(spec.input)
    else child.stdin?.end()

    return { taskId }
  }
}

export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1
        current += input[i]
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken || current) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
  }
  if (quote) throw new Error('Unterminated quote in command')
  if (hasToken || current) tokens.push(current)
  return tokens
}

type FlagArity = 0 | 1 | 'optional'
type Flags = { long: Record<string, FlagArity>; short: Record<string, FlagArity> }

type PositionalKind =
  | 'none'
  | 'revision'
  | 'ref'
  | 'path'
  | 'word'
  | 'stash'
  | 'tag'
  | 'remote-branch'
  | 'revision-path'
  | 'blame'
  | 'stash-branch'

interface Positionals {
  kind: PositionalKind
  min: number
  max: number
}

interface CommandSpec extends Flags {
  positionals: Positionals
  verbs?: Record<string, CommandSpec>
  allowNoVerb?: boolean
  /** Flags that change what the positionals mean (for example `tag --list`). */
  variant?: (used: ReadonlySet<string>) => Positionals | undefined
  /** A command that must see at least one of these flags. */
  requiresOneOf?: string[]
}

const none: Positionals = { kind: 'none', min: 0, max: 0 }
const revisions = (max: number, min = 0): Positionals => ({ kind: 'revision', min, max })
const paths = (min = 0, max = 1000): Positionals => ({ kind: 'path', min, max })
const refs = (max: number, min = 0): Positionals => ({ kind: 'ref', min, max })
const words = (max: number, min = 0): Positionals => ({ kind: 'word', min, max })
const revisionPaths = (max: number, min = 0): Positionals => ({ kind: 'revision-path', min, max })

/** Options that make Git or a helper run another program. Never allowed. */
const EXECUTION_OPTIONS = new Set([
  '--exec',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--config-env',
  '--config',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--pager',
  '--open-files-in-pager',
  '--editor'
])

/** Global options that cannot change the repository, the configuration or the pager. */
const GLOBAL_FLAGS: Record<string, FlagArity> = {
  '--no-pager': 0,
  '--no-replace-objects': 0,
  '--literal-pathspecs': 0,
  '--no-optional-locks': 0
}

const LOG_FLAGS: Flags = {
  long: {
    '--oneline': 0,
    '--graph': 0,
    '--decorate': 'optional',
    '--no-decorate': 0,
    '--all': 0,
    '--branches': 'optional',
    '--tags': 'optional',
    '--remotes': 'optional',
    '--max-count': 1,
    '--skip': 1,
    '--grep': 1,
    '--author': 1,
    '--committer': 1,
    '--since': 1,
    '--until': 1,
    '--pretty': 1,
    '--format': 1,
    '--date': 'optional',
    '--stat': 0,
    '--shortstat': 0,
    '--numstat': 0,
    '--name-only': 0,
    '--name-status': 0,
    '--no-merges': 0,
    '--merges': 0,
    '--first-parent': 0,
    '--reverse': 0,
    '--follow': 0,
    '--abbrev-commit': 0,
    '--no-abbrev-commit': 0,
    '--abbrev': 'optional',
    '--patch': 0,
    '--no-patch': 0,
    '--color': 'optional',
    '--no-color': 0,
    '--regexp-ignore-case': 0,
    '--extended-regexp': 0,
    '--fixed-strings': 0,
    '--no-renames': 0,
    '--find-renames': 'optional',
    '--topo-order': 0,
    '--date-order': 0,
    '--author-date-order': 0
  },
  short: { n: 1, p: 0, s: 0, i: 0, E: 0, F: 0, m: 0 }
}

const COMMANDS: Record<string, CommandSpec> = {
  status: {
    long: {
      '--short': 0,
      '--branch': 0,
      '--porcelain': 'optional',
      '--long': 0,
      '--verbose': 0,
      '--show-stash': 0,
      '--ahead-behind': 0,
      '--no-ahead-behind': 0,
      '--untracked-files': 'optional',
      '--ignored': 'optional',
      '--renames': 0,
      '--no-renames': 0,
      '--find-renames': 'optional',
      '--column': 'optional',
      '--no-column': 0,
      '--ignore-submodules': 'optional'
    },
    short: { s: 0, b: 0, v: 0, z: 0, u: 'optional' },
    positionals: paths()
  },
  log: { ...LOG_FLAGS, positionals: revisionPaths(500) },
  show: {
    long: {
      '--stat': 0,
      '--shortstat': 0,
      '--numstat': 0,
      '--name-only': 0,
      '--name-status': 0,
      '--patch': 0,
      '--no-patch': 0,
      '--pretty': 1,
      '--format': 1,
      '--oneline': 0,
      '--decorate': 'optional',
      '--no-decorate': 0,
      '--no-color': 0,
      '--color': 'optional',
      '--abbrev-commit': 0,
      '--no-abbrev-commit': 0,
      '--first-parent': 0,
      '--no-renames': 0,
      '--find-renames': 'optional',
      '--date': 'optional',
      '--no-ext-diff': 0,
      '--text': 0
    },
    short: { s: 0, p: 0 },
    positionals: revisionPaths(500)
  },
  diff: {
    long: {
      '--stat': 0,
      '--shortstat': 0,
      '--numstat': 0,
      '--name-only': 0,
      '--name-status': 0,
      '--patch': 0,
      '--no-patch': 0,
      '--cached': 0,
      '--staged': 0,
      '--merge-base': 0,
      '--find-renames': 'optional',
      '--no-renames': 0,
      '--color': 'optional',
      '--no-color': 0,
      '--word-diff': 'optional',
      '--ignore-all-space': 0,
      '--ignore-space-change': 0,
      '--ignore-blank-lines': 0,
      '--unified': 1,
      '--no-ext-diff': 0,
      '--text': 0,
      '--binary': 0,
      '--exit-code': 0,
      '--quiet': 0,
      '--check': 0,
      '--submodule': 'optional',
      '--diff-filter': 1
    },
    short: { p: 0, s: 0, w: 0, b: 0, a: 0, U: 1 },
    positionals: revisionPaths(2)
  },
  blame: {
    long: {
      '--line-porcelain': 0,
      '--porcelain': 0,
      '--incremental': 0,
      '--show-name': 0,
      '--show-number': 0,
      '--show-email': 0,
      '--date': 1,
      '--no-color': 0,
      '--root': 0,
      '--ignore-rev': 1
    },
    short: { p: 0, w: 0, M: 'optional', C: 'optional', L: 1, e: 0, f: 0, n: 0, s: 0, b: 0 },
    positionals: { kind: 'blame', min: 1, max: 1 }
  },
  'rev-parse': {
    long: {
      '--verify': 0,
      '--quiet': 0,
      '--short': 'optional',
      '--abbrev-ref': 'optional',
      '--symbolic': 0,
      '--symbolic-full-name': 'optional',
      '--show-toplevel': 0,
      '--show-prefix': 0,
      '--show-cdup': 0,
      '--git-dir': 0,
      '--absolute-git-dir': 0,
      '--git-common-dir': 0,
      '--is-bare-repository': 0,
      '--is-inside-work-tree': 0,
      '--is-inside-git-dir': 0,
      '--is-shallow-repository': 0,
      '--show-superproject-working-tree': 0,
      '--path-format': 1,
      '--default': 1,
      '--revs-only': 0,
      '--no-revs': 0,
      '--flags': 0,
      '--no-flags': 0,
      '--all': 0,
      '--branches': 'optional',
      '--tags': 'optional',
      '--remotes': 'optional'
    },
    short: { q: 0, s: 'optional', t: 0, g: 0 },
    positionals: revisions(200)
  },
  'for-each-ref': {
    long: {
      '--format': 1,
      '--sort': 1,
      '--count': 1,
      '--contains': 1,
      '--no-contains': 1,
      '--points-at': 1,
      '--merged': 1,
      '--no-merged': 1,
      '--shell': 0,
      '--python': 0,
      '--perl': 0,
      '--tcl': 0
    },
    short: {},
    positionals: words(100)
  },
  'ls-files': {
    long: {
      '--stage': 0,
      '--cached': 0,
      '--deleted': 0,
      '--modified': 0,
      '--others': 0,
      '--ignored': 0,
      '--exclude-standard': 0,
      '--exclude': 1,
      '--directory': 0,
      '--error-unmatch': 0,
      '--unmerged': 0,
      '--debug': 0,
      '--full-name': 0,
      '--recurse-submodules': 0,
      '--with-tree': 1,
      '--deduplicate': 0,
      '--eol': 0,
      '--resolve-undo': 0
    },
    short: { s: 0, c: 0, d: 0, m: 0, o: 0, i: 0, x: 1, u: 0, z: 0, k: 0, t: 0, f: 0, v: 0 },
    positionals: paths()
  },
  shortlog: {
    long: {
      '--summary': 0,
      '--numbered': 0,
      '--email': 0,
      '--no-merges': 0,
      '--all': 0,
      '--branches': 'optional',
      '--tags': 'optional',
      '--remotes': 'optional',
      '--format': 1,
      '--group': 1,
      '--since': 1,
      '--until': 1,
      '--author': 1
    },
    short: { s: 0, n: 0, e: 0 },
    positionals: revisionPaths(200)
  },
  describe: {
    long: {
      '--tags': 0,
      '--always': 0,
      '--long': 0,
      '--dirty': 'optional',
      '--broken': 'optional',
      '--abbrev': 1,
      '--match': 1,
      '--exclude': 1,
      '--contains': 0,
      '--all': 0,
      '--first-parent': 0,
      '--candidates': 1
    },
    short: { t: 0 },
    positionals: revisions(1)
  },
  reflog: {
    long: {},
    short: {},
    positionals: none,
    allowNoVerb: true,
    verbs: {
      show: { ...LOG_FLAGS, positionals: revisionPaths(1) }
    }
  },
  gc: {
    long: {
      '--prune': 'optional',
      '--aggressive': 0,
      '--auto': 0,
      '--quiet': 0,
      '--force': 0,
      '--keep-largest-pack': 0,
      '--no-prune': 0
    },
    short: { q: 0 },
    positionals: none
  },
  fsck: {
    long: {
      '--full': 0,
      '--strict': 0,
      '--unreachable': 0,
      '--lost-found': 0,
      '--verbose': 0,
      '--no-progress': 0,
      '--connectivity-only': 0,
      '--no-dangling': 0,
      '--dangling': 0,
      '--root': 0,
      '--tags': 0,
      '--cache': 0
    },
    short: {},
    positionals: none
  },
  'count-objects': {
    long: { '--human-readable': 0, '--verbose': 0 },
    short: { v: 0, H: 0 },
    positionals: none
  },
  maintenance: {
    long: {},
    short: {},
    positionals: none,
    verbs: {
      run: {
        long: { '--auto': 0, '--schedule': 1, '--task': 1, '--quiet': 0 },
        short: { q: 0 },
        positionals: none
      },
      start: {
        long: { '--scheduler': 1, '--quiet': 0 },
        short: { q: 0 },
        positionals: none
      },
      stop: {
        long: { '--quiet': 0 },
        short: { q: 0 },
        positionals: none
      }
    }
  },
  clean: {
    long: {
      '--dry-run': 0,
      '--force': 0,
      '--quiet': 0,
      '--exclude': 1,
      '--ignored': 0,
      '--no-ignored': 0
    },
    short: { n: 0, f: 0, q: 0, d: 0, x: 0, X: 0, e: 1 },
    positionals: paths()
  },
  mv: {
    long: { '--force': 0, '--dry-run': 0, '--verbose': 0 },
    short: { f: 0, k: 0, n: 0, v: 0 },
    positionals: paths(2, 2)
  },
  rm: {
    long: {
      '--force': 0,
      '--dry-run': 0,
      '--cached': 0,
      '--ignore-unmatch': 0,
      '--quiet': 0,
      '--recursive': 0
    },
    short: { f: 0, n: 0, r: 0, q: 0 },
    positionals: paths(1, 1000)
  },
  add: {
    long: {
      '--all': 0,
      '--update': 0,
      '--dry-run': 0,
      '--verbose': 0,
      '--force': 0,
      '--intent-to-add': 0,
      '--renormalize': 0,
      '--ignore-removal': 0,
      '--no-all': 0,
      '--chmod': 1,
      '--ignore-errors': 0,
      '--sparse': 0
    },
    short: { A: 0, u: 0, n: 0, v: 0, f: 0, N: 0 },
    positionals: paths()
  },
  restore: {
    long: {
      '--staged': 0,
      '--worktree': 0,
      '--source': 1,
      '--ours': 0,
      '--theirs': 0,
      '--merge': 0,
      '--ignore-unmatch': 0,
      '--overlay': 0,
      '--no-overlay': 0,
      '--progress': 0,
      '--no-progress': 0,
      '--quiet': 0
    },
    short: { S: 0, W: 0, s: 1, m: 0, q: 0 },
    positionals: paths()
  },
  switch: {
    long: {
      '--create': 1,
      '--force-create': 1,
      '--detach': 0,
      '--force': 0,
      '--merge': 0,
      '--track': 'optional',
      '--no-track': 0,
      '--orphan': 1,
      '--discard-changes': 0,
      '--quiet': 0,
      '--progress': 0,
      '--no-progress': 0,
      '--guess': 0,
      '--no-guess': 0
    },
    short: { c: 1, C: 1, d: 0, f: 0, m: 0, t: 'optional', q: 0 },
    positionals: revisions(1)
  },
  checkout: {
    long: {
      '--detach': 0,
      '--force': 0,
      '--merge': 0,
      '--ours': 0,
      '--theirs': 0,
      '--quiet': 0,
      '--track': 'optional',
      '--no-track': 0,
      '--orphan': 1,
      '--progress': 0,
      '--no-progress': 0,
      '--guess': 0,
      '--no-guess': 0,
      '--overwrite-ignore': 0
    },
    short: { b: 1, B: 1, f: 0, m: 0, q: 0, t: 'optional' },
    positionals: revisionPaths(1)
  },
  merge: {
    long: {
      '--no-ff': 0,
      '--ff-only': 0,
      '--ff': 'optional',
      '--squash': 0,
      '--no-commit': 0,
      '--commit': 0,
      '--no-edit': 0,
      '--message': 1,
      '--abort': 0,
      '--continue': 0,
      '--quit': 0,
      '--strategy': 1,
      '--strategy-option': 1,
      '--allow-unrelated-histories': 0,
      '--autostash': 0,
      '--no-autostash': 0,
      '--quiet': 0,
      '--verbose': 0,
      '--stat': 0,
      '--no-stat': 0
    },
    short: { m: 1, s: 1, X: 1, q: 0, v: 0, n: 0 },
    positionals: revisions(100)
  },
  rebase: {
    long: {
      '--onto': 1,
      '--continue': 0,
      '--abort': 0,
      '--skip': 0,
      '--quit': 0,
      '--interactive': 0,
      '--autosquash': 0,
      '--no-autosquash': 0,
      '--autostash': 0,
      '--no-autostash': 0,
      '--keep-empty': 0,
      '--no-keep-empty': 0,
      '--rebase-merges': 'optional',
      '--no-rebase-merges': 0,
      '--root': 0,
      '--fork-point': 0,
      '--no-fork-point': 0,
      '--preserve-merges': 0,
      '--merge': 0,
      '--apply': 0,
      '--no-apply': 0,
      '--whitespace': 1,
      '--committer-date-is-author-date': 0,
      '--ignore-date': 0,
      '--reset-author-date': 0,
      '--quiet': 0,
      '--verbose': 0,
      '--stat': 0,
      '--no-stat': 0,
      '--no-verify': 0,
      '--verify': 0,
      '--signoff': 0,
      '--no-signoff': 0,
      '--empty': 1
    },
    short: { i: 0, m: 0, q: 0, v: 0, s: 1, X: 1 },
    positionals: revisions(1)
  },
  'cherry-pick': {
    long: {
      '--edit': 0,
      '--no-commit': 0,
      '--mainline': 1,
      '--ff': 0,
      '--allow-empty': 0,
      '--allow-empty-message': 0,
      '--keep-redundant-commits': 0,
      '--continue': 0,
      '--abort': 0,
      '--skip': 0,
      '--signoff': 0,
      '--strategy': 1,
      '--strategy-option': 1
    },
    short: { e: 0, n: 0, m: 1, x: 0, s: 0, S: 'optional' },
    positionals: revisions(500)
  },
  revert: {
    long: {
      '--no-edit': 0,
      '--no-commit': 0,
      '--mainline': 1,
      '--continue': 0,
      '--abort': 0,
      '--skip': 0,
      '--signoff': 0,
      '--strategy': 1,
      '--strategy-option': 1
    },
    short: { n: 0, m: 1, s: 0, S: 'optional' },
    positionals: revisions(500)
  },
  reset: {
    long: {
      '--soft': 0,
      '--mixed': 0,
      '--hard': 0,
      '--merge': 0,
      '--keep': 0,
      '--quiet': 0,
      '--no-refresh': 0,
      '--refresh': 0,
      '--intent-to-add': 0
    },
    short: { q: 0, N: 0 },
    positionals: revisionPaths(1)
  },
  commit: {
    long: {
      '--message': 1,
      '--amend': 0,
      '--all': 0,
      '--no-verify': 0,
      '--signoff': 0,
      '--allow-empty': 0,
      '--allow-empty-message': 0,
      '--no-edit': 0,
      '--quiet': 0,
      '--verbose': 0,
      '--fixup': 1,
      '--squash': 1,
      '--author': 1,
      '--date': 1,
      '--cleanup': 1,
      '--trailer': 1,
      '--reuse-message': 1,
      '--reedit-message': 1,
      '--gpg-sign': 'optional',
      '--no-gpg-sign': 0,
      '--only': 0,
      '--include': 0,
      '--dry-run': 0,
      '--status': 0,
      '--no-status': 0,
      '--short': 0,
      '--branch': 0,
      '--porcelain': 0,
      '--long': 0
    },
    short: { m: 1, a: 0, n: 0, s: 0, q: 0, v: 0, C: 1, c: 1, S: 'optional', e: 0 },
    positionals: paths()
  },
  fetch: {
    long: {
      '--all': 0,
      '--prune': 0,
      '--no-prune': 0,
      '--tags': 0,
      '--no-tags': 0,
      '--force': 0,
      '--verbose': 0,
      '--quiet': 0,
      '--depth': 1,
      '--multiple': 0,
      '--atomic': 0,
      '--ipv4': 0,
      '--ipv6': 0,
      '--progress': 0,
      '--no-progress': 0,
      '--dry-run': 0,
      '--set-upstream': 0,
      '--append': 0,
      '--no-write-fetch-head': 0,
      '--write-fetch-head': 0,
      '--recurse-submodules': 'optional',
      '--no-recurse-submodules': 0,
      '--jobs': 1,
      '--prefetch': 0,
      '--refetch': 0,
      '--filter': 1
    },
    short: { f: 0, v: 0, q: 0, p: 0, t: 0, j: 1 },
    positionals: words(2)
  },
  pull: {
    long: {
      '--rebase': 'optional',
      '--no-rebase': 0,
      '--ff-only': 0,
      '--no-ff': 0,
      '--ff': 'optional',
      '--squash': 0,
      '--no-commit': 0,
      '--commit': 0,
      '--autostash': 0,
      '--no-autostash': 0,
      '--progress': 0,
      '--no-progress': 0,
      '--verbose': 0,
      '--quiet': 0,
      '--all': 0,
      '--tags': 0,
      '--no-tags': 0,
      '--depth': 1,
      '--allow-unrelated-histories': 0,
      '--no-edit': 0,
      '--no-stat': 0,
      '--stat': 0,
      '--strategy': 1,
      '--strategy-option': 1,
      '--recurse-submodules': 'optional',
      '--no-recurse-submodules': 0,
      '--jobs': 1,
      '--dry-run': 0
    },
    short: { v: 0, q: 0, s: 1, X: 1, r: 0, j: 1 },
    positionals: { kind: 'remote-branch', min: 0, max: 2 }
  },
  push: {
    long: {
      '--set-upstream': 0,
      '--force': 0,
      '--force-with-lease': 'optional',
      '--no-force-with-lease': 0,
      '--force-if-includes': 0,
      '--no-force-if-includes': 0,
      '--signed': 'optional',
      '--no-signed': 0,
      '--tags': 0,
      '--all': 0,
      '--branches': 0,
      '--delete': 0,
      '--dry-run': 0,
      '--porcelain': 0,
      '--progress': 0,
      '--no-progress': 0,
      '--verbose': 0,
      '--quiet': 0,
      '--atomic': 0,
      '--no-atomic': 0,
      '--follow-tags': 0,
      '--no-follow-tags': 0,
      '--prune': 0,
      '--no-prune': 0,
      '--push-option': 1,
      '--recurse-submodules': 'optional',
      '--no-recurse-submodules': 0,
      '--thin': 0,
      '--no-thin': 0,
      '--ipv4': 0,
      '--ipv6': 0
    },
    short: { u: 0, f: 0, n: 0, v: 0, q: 0, d: 0 },
    positionals: words(100)
  },
  branch: {
    long: {
      '--all': 0,
      '--remotes': 0,
      '--verbose': 0,
      '--delete': 0,
      '--move': 0,
      '--copy': 0,
      '--force': 0,
      '--merged': 'optional',
      '--no-merged': 'optional',
      '--contains': 'optional',
      '--no-contains': 'optional',
      '--set-upstream-to': 1,
      '--unset-upstream': 0,
      '--show-current': 0,
      '--list': 'optional',
      '--format': 1,
      '--sort': 1,
      '--column': 'optional',
      '--no-column': 0,
      '--track': 'optional',
      '--no-track': 0,
      '--points-at': 1,
      '--ignore-case': 0,
      '--omit-empty': 0,
      '--no-abbrev': 0,
      '--abbrev': 'optional',
      '--quiet': 0
    },
    short: { a: 0, r: 0, v: 0, d: 0, D: 0, m: 0, M: 0, c: 0, C: 0, f: 0, l: 'optional', u: 1, t: 'optional', q: 0 },
    positionals: refs(2),
    variant: (used) =>
      used.has('--list') || used.has('-l') ? words(100) : undefined
  },
  tag: {
    long: {
      '--list': 'optional',
      '--annotate': 0,
      '--message': 1,
      '--delete': 0,
      '--force': 0,
      '--sign': 0,
      '--local-user': 1,
      '--verify': 0,
      '--contains': 'optional',
      '--no-contains': 'optional',
      '--merged': 'optional',
      '--no-merged': 'optional',
      '--points-at': 1,
      '--sort': 1,
      '--format': 1,
      '--column': 'optional',
      '--no-column': 0,
      '--cleanup': 1,
      '--create-reflog': 0,
      '--no-create-reflog': 0
    },
    short: { l: 'optional', a: 0, m: 1, d: 0, f: 0, s: 0, v: 0, n: 'optional', u: 1 },
    positionals: { kind: 'tag', min: 0, max: 2 },
    variant: (used) => (used.has('--list') || used.has('-l') ? words(100) : undefined)
  },
  remote: {
    long: { '--verbose': 0, '--no-verbose': 0 },
    short: { v: 0 },
    positionals: none,
    allowNoVerb: true,
    verbs: {
      show: { long: {}, short: {}, positionals: words(1, 1) },
      'get-url': {
        long: { '--all': 0, '--push': 0 },
        short: {},
        positionals: words(1, 1)
      },
      prune: {
        long: { '--dry-run': 0, '--verbose': 0 },
        short: { n: 0, v: 0 },
        positionals: words(1)
      }
    }
  },
  worktree: {
    long: {},
    short: {},
    positionals: none,
    verbs: {
      list: {
        long: { '--porcelain': 0, '--verbose': 0 },
        short: { v: 0, z: 0 },
        positionals: none
      },
      prune: {
        long: { '--dry-run': 0, '--verbose': 0, '--expire': 1 },
        short: { n: 0, v: 0 },
        positionals: none
      },
      remove: {
        long: { '--force': 0 },
        short: { f: 0 },
        positionals: paths(1, 1)
      }
    }
  },
  stash: {
    long: {},
    short: {},
    positionals: none,
    allowNoVerb: true,
    verbs: {
      list: { long: { '--format': 1 }, short: { z: 0 }, positionals: { kind: 'stash', min: 0, max: 1 } },
      show: {
        long: {
          '--stat': 0,
          '--patch': 0,
          '--name-only': 0,
          '--no-patch': 0,
          '--format': 1
        },
        short: { p: 0 },
        positionals: { kind: 'stash', min: 0, max: 1 }
      },
      push: {
        long: {
          '--include-untracked': 0,
          '--all': 0,
          '--message': 1,
          '--keep-index': 0,
          '--no-keep-index': 0,
          '--quiet': 0,
          '--staged': 0
        },
        short: { u: 0, a: 0, m: 1, q: 0 },
        positionals: paths()
      },
      pop: {
        long: { '--index': 0, '--quiet': 0 },
        short: { q: 0 },
        positionals: { kind: 'stash', min: 0, max: 1 }
      },
      apply: {
        long: { '--index': 0, '--quiet': 0 },
        short: { q: 0 },
        positionals: { kind: 'stash', min: 0, max: 1 }
      },
      drop: {
        long: { '--quiet': 0 },
        short: { q: 0 },
        positionals: { kind: 'stash', min: 1, max: 1 }
      },
      branch: {
        long: {},
        short: {},
        positionals: { kind: 'stash-branch', min: 1, max: 2 }
      },
      create: { long: {}, short: {}, positionals: { kind: 'stash', min: 0, max: 1 } },
      clear: { long: {}, short: {}, positionals: none }
    }
  },
  submodule: {
    long: {},
    short: {},
    positionals: none,
    verbs: {
      status: {
        long: { '--recursive': 0, '--cached': 0 },
        short: {},
        positionals: paths()
      },
      summary: {
        long: { '--cached': 0, '--files': 0 },
        short: {},
        positionals: paths()
      },
      sync: {
        long: { '--recursive': 0 },
        short: {},
        positionals: paths()
      }
    }
  },
  config: {
    long: {
      '--get': 0,
      '--get-all': 0,
      '--get-regexp': 0,
      '--list': 0,
      '--show-origin': 0,
      '--show-scope': 0,
      '--name-only': 0,
      '--local': 0,
      '--global': 0,
      '--system': 0,
      '--worktree': 0,
      '--includes': 0,
      '--no-includes': 0,
      '--null': 0,
      '--type': 1,
      '--bool': 0,
      '--int': 0,
      '--path': 0,
      '--default': 1
    },
    short: { l: 0, z: 0 },
    positionals: words(2),
    requiresOneOf: ['--get', '--get-all', '--get-regexp', '--list', '-l']
  },
  version: { long: {}, short: {}, positionals: none },
  whatchanged: { ...LOG_FLAGS, positionals: revisionPaths(500) }
}

function flattenFlags(spec: CommandSpec): Flags {
  const long: Record<string, FlagArity> = { ...spec.long }
  const short: Record<string, FlagArity> = { ...spec.short }
  for (const child of Object.values(spec.verbs ?? {})) {
    const nested = flattenFlags(child)
    Object.assign(long, nested.long)
    Object.assign(short, nested.short)
  }
  return { long, short }
}

function validateRevisionToken(token: string): void {
  revision(token, 'Revision')
}

function validateRefToken(token: string): void {
  refName(token, 'Branch or tag name')
}

function validatePathToken(token: string): void {
  if (token.startsWith('-')) throw new Error(`Invalid path in the console command: ${token}`)
  relPath(token, 'Path')
}

function validateWordToken(token: string): void {
  word(token, 'Argument')
}

function validateStashToken(token: string): void {
  if (!/^(?:\d+|stash@\{\d+\})$/.test(token)) throw new Error('Invalid stash reference')
}

function validatePositionals(spec: CommandSpec, used: ReadonlySet<string>, tokens: string[], pathsAfterSeparator: string[]): void {
  if (spec.requiresOneOf && !spec.requiresOneOf.some((flag) => used.has(flag))) {
    throw new Error('The console only allows read-only git config queries')
  }
  const override = spec.variant?.(used)
  const positionals = override ?? spec.positionals
  if (pathsAfterSeparator.length && !['path', 'revision-path', 'blame'].includes(positionals.kind)) {
    throw new Error('Paths are not allowed for this command')
  }
  if (positionals.kind === 'none') {
    if (tokens.length) throw new Error('This command does not take arguments')
    return
  }
  if (positionals.kind === 'path') {
    const all = [...tokens, ...pathsAfterSeparator]
    if (all.length < positionals.min || all.length > positionals.max) throw new Error('Wrong number of paths')
    all.forEach(validatePathToken)
    return
  }
  if (positionals.kind === 'revision-path') {
    if (tokens.length < positionals.min || tokens.length > positionals.max) throw new Error('Wrong number of revisions')
    tokens.forEach(validateRevisionToken)
    pathsAfterSeparator.forEach(validatePathToken)
    return
  }
  if (positionals.kind === 'blame') {
    if (pathsAfterSeparator.length) {
      if (tokens.length > 1) throw new Error('Wrong number of revisions')
      tokens.forEach(validateRevisionToken)
      pathsAfterSeparator.forEach(validatePathToken)
      return
    }
    if (tokens.length !== 1) throw new Error('Specify one file to blame')
    validatePathToken(tokens[0])
    return
  }
  if (positionals.kind === 'stash-branch') {
    if (tokens.length < positionals.min || tokens.length > positionals.max) throw new Error('Wrong number of arguments')
    validateRefToken(tokens[0])
    if (tokens[1] !== undefined) validateStashToken(tokens[1])
    return
  }
  if (positionals.kind === 'remote-branch') {
    if (tokens.length < positionals.min || tokens.length > positionals.max) throw new Error('Wrong number of arguments')
    if (tokens[0] !== undefined) validateWordToken(tokens[0])
    tokens.slice(1).forEach(validateRevisionToken)
    return
  }
  if (positionals.kind === 'tag') {
    if (tokens.length < positionals.min || tokens.length > positionals.max) throw new Error('Wrong number of arguments')
    if (tokens[0] !== undefined) validateRefToken(tokens[0])
    if (tokens[1] !== undefined) validateRevisionToken(tokens[1])
    return
  }
  const validate = {
    revision: validateRevisionToken,
    ref: validateRefToken,
    word: validateWordToken,
    stash: validateStashToken
  }[positionals.kind]
  if (tokens.length < positionals.min || tokens.length > positionals.max) throw new Error('Wrong number of arguments')
  tokens.forEach(validate)
}

function parseFlags(
  spec: CommandSpec,
  tokens: string[]
): { positionals: string[]; paths: string[]; used: Set<string> } {
  const flags = flattenFlags(spec)
  const positionals: string[] = []
  const paths: string[] = []
  const used = new Set<string>()
  let afterSeparator = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (afterSeparator) {
      paths.push(token)
      continue
    }
    if (token === '--') {
      afterSeparator = true
      continue
    }
    if (token === '' || token === '-') {
      positionals.push(token)
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals >= 0 ? token.slice(0, equals) : token
      if (EXECUTION_OPTIONS.has(name)) throw new Error(`"${name}" is not allowed in the console`)
      const arity = flags.long[name]
      if (arity === undefined) throw new Error(`Option "${name}" is not available in the console`)
      used.add(name)
      if (equals >= 0) {
        if (arity === 0) throw new Error(`Option "${name}" does not take a value`)
        continue
      }
      if (arity === 1) {
        if (index + 1 >= tokens.length || tokens[index + 1] === '--') {
          throw new Error(`Option "${name}" needs a value`)
        }
        // Never consume an option-shaped token as a value: `--pretty
        // --output=/x` would otherwise hand Git a file-writing option.
        if (tokens[index + 1].startsWith('-')) {
          throw new Error(`Option "${name}" needs a value (use --${name.slice(2)}=value for values starting with "-")`)
        }
        index += 1
      }
      continue
    }
    // `-5` is Git's count shorthand for log/show.
    if (/^-\d+$/.test(token)) {
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let offset = 1; offset < token.length; offset += 1) {
        const char = token[offset]
        const name = `-${char}`
        if (EXECUTION_OPTIONS.has(name)) throw new Error(`"${name}" is not allowed in the console`)
        const arity = flags.short[char]
        if (arity === undefined) throw new Error(`Option "${name}" is not available in the console`)
        used.add(name)
        if (arity === 0) continue
        const attached = token.slice(offset + 1)
        if (attached) break
        if (arity === 1) {
          if (index + 1 >= tokens.length || tokens[index + 1] === '--') {
            throw new Error(`Option "${name}" needs a value`)
          }
          if (tokens[index + 1].startsWith('-')) {
            throw new Error(`Option "${name}" needs a value (attach it, for example -n10)`)
          }
          index += 1
        }
        break
      }
      continue
    }
    positionals.push(token)
  }
  return { positionals, paths, used }
}

export function validateConsoleCommand(input: string): string[] {
  const tokens = tokenizeCommand(input.trim())
  if (!tokens.length) throw new Error('Enter a git command')
  if (tokens[0] !== 'git' && tokens[0] !== 'git.exe') throw new Error('The console only runs git commands')
  const rest = tokens.slice(1)
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) {
    const token = rest[index]
    if (token === '--') break
    const equals = token.indexOf('=')
    const name = token.startsWith('--') && equals >= 0 ? token.slice(0, equals) : token
    if (GLOBAL_FLAGS[name] === undefined) {
      throw new Error('Global git options are not allowed in the console')
    }
    if (GLOBAL_FLAGS[name] === 0 && equals >= 0) throw new Error('Global git options are not allowed in the console')
    index += 1
  }
  const subcommand = rest[index] ?? ''
  const spec = COMMANDS[subcommand]
  if (!spec) throw new Error(`"git ${subcommand}" is not available in the console`)
  const { positionals, paths, used } = parseFlags(spec, rest.slice(index + 1))
  if (spec.verbs) {
    if (!positionals.length) {
      if (!spec.allowNoVerb) throw new Error(`Enter a "git ${subcommand}" subcommand`)
      validatePositionals(spec, used, positionals, paths)
    } else {
      const verb = positionals[0]
      const child = spec.verbs[verb]
      if (!child) throw new Error(`"git ${subcommand} ${verb}" is not available in the console`)
      validatePositionals(child, used, positionals.slice(1), paths)
    }
  } else {
    validatePositionals(spec, used, positionals, paths)
  }
  return rest
}
