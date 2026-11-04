import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { TaskEvent, TaskHandle } from '@shared/types'
import { getGitBinary, gitBaseArgs, redact } from './git/runner'

export interface TaskSpec {
  kind: TaskEvent['kind']
  title: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string
  secrets?: Array<string | null | undefined>
  onExit?: (code: number | null, output: string) => void | Promise<void>
}

export interface TaskResult {
  code: number | null
  output: string
}

export class TaskManager {
  private readonly emit: (event: TaskEvent) => void

  constructor(emit: (event: TaskEvent) => void) {
    this.emit = emit
  }

  start(spec: TaskSpec): TaskHandle {
    const taskId = randomUUID()
    const secrets = spec.secrets ?? []
    let buffer = ''
    let fullOutput = ''
    let finished = false

    const send = (event: TaskEvent): void => {
      if (event.text) event.text = redact(event.text, secrets)
      if (event.error) event.error = redact(event.error, secrets)
      this.emit(event)
    }

    send({ taskId, kind: spec.kind, phase: 'start', text: spec.title })

    const child = spawn(getGitBinary(), [...gitBaseArgs(), ...spec.args], {
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

    const flush = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      buffer += chunk
      const lines = buffer.split(/\r\n|\n|\r/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        fullOutput += `${line}\n`
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
      send({ taskId, kind: spec.kind, phase: 'error', error: error.message })
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      if (buffer.trim()) {
        fullOutput += `${buffer}\n`
        send({ taskId, kind: spec.kind, phase: 'output', text: buffer, stream: 'stdout' })
      }
      if (code !== 0) {
        send({
          taskId,
          kind: spec.kind,
          phase: 'error',
          exitCode: code ?? undefined,
          error: spec.kind === 'console' ? 'Command failed' : `${spec.title} failed (exit code ${code ?? 'unknown'})`,
          text: fullOutput.slice(-4000)
        })
      } else {
        send({ taskId, kind: spec.kind, phase: 'end', exitCode: 0, text: fullOutput.slice(-4000) })
      }
      void spec.onExit?.(code, fullOutput)
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

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'fetch',
  'pull',
  'push',
  'branch',
  'tag',
  'remote',
  'worktree',
  'stash',
  'commit',
  'add',
  'restore',
  'switch',
  'checkout',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'reset',
  'blame',
  'rev-parse',
  'for-each-ref',
  'ls-files',
  'shortlog',
  'describe',
  'reflog',
  'gc',
  'fsck',
  'count-objects',
  'maintenance',
  'clean',
  'mv',
  'rm',
  'notes',
  'submodule',
  'config',
  'version',
  'help',
  'whatchanged'
])

const SAFE_CONFIG_VERBS = new Set(['--get', '--get-all', '--list', '--show-origin', '--show-scope', '-l'])

export function validateConsoleCommand(input: string): string[] {
  const tokens = tokenizeCommand(input.trim())
  if (!tokens.length) throw new Error('Enter a git command')
  if (tokens[0] !== 'git' && tokens[0] !== 'git.exe') throw new Error('The console only runs git commands')
  const rest = tokens.slice(1)
  if (!rest.length) throw new Error('Enter a git subcommand')
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) {
    const token = rest[index]
    if (token === '-c' || token === '--config-env' || token === '-C') {
      throw new Error('Global git options are not allowed in the console')
    }
    if (token.startsWith('--git-dir') || token.startsWith('--work-tree')) {
      throw new Error('Repository overrides are not allowed in the console')
    }
    index += 1
  }
  const subcommand = rest[index] ?? ''
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`"git ${subcommand}" is not available in the console`)
  }
  if (rest.some((token) => token.includes('alias.'))) {
    throw new Error('Alias commands are not allowed in the console')
  }
  if (subcommand === 'config') {
    const verb = rest[index + 1]
    if (!verb || !SAFE_CONFIG_VERBS.has(verb)) {
      throw new Error('The console only allows read-only git config queries')
    }
  }
  if ((subcommand === 'rebase' || subcommand === 'bisect') && rest.some((token) => token === '--exec')) {
    throw new Error('--exec is not allowed in the console')
  }
  if (subcommand === 'submodule' && rest[index + 1] === 'foreach') {
    throw new Error('submodule foreach is not allowed in the console')
  }
  return rest
}
