import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import { TASK_RECENT_LIMIT, TASK_TAIL_BYTES, TaskManager, TaskOutputBuffer } from '../src/main/tasks'
import type { TaskEvent } from '../src/shared/types'

interface RunOptions {
  onExit?: (code: number | null) => void | Promise<void>
  onEvent?: (event: TaskEvent) => void
}

function runTask(repoPath: string | undefined, options: RunOptions = {}): Promise<TaskEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TaskEvent[] = []
    const timeout = setTimeout(() => reject(new Error('task did not finish')), 15000)
    const tasks = new TaskManager((event) => {
      options.onEvent?.(event)
      events.push(event)
      if (event.phase === 'end') {
        clearTimeout(timeout)
        resolve(events)
      }
      if (event.phase === 'error') {
        clearTimeout(timeout)
        reject(new Error(event.error ?? 'task failed'))
      }
    })
    tasks.start({
      kind: 'console',
      title: 'git version',
      args: ['version'],
      cwd: os.tmpdir(),
      repoPath,
      onExit: options.onExit
    })
  })
}

describe('bounded task output', () => {
  it('caps a newline-free stream instead of growing without limit', () => {
    const buffer = new TaskOutputBuffer(20, 8)
    const emitted = buffer.push('x'.repeat(50))
    expect(emitted.length).toBeGreaterThan(1)
    expect(emitted.every((line) => line.length <= 8)).toBe(true)
    expect(buffer.tail.length).toBeLessThanOrEqual(20)
  })

  it('keeps the retained tail bounded for long output', () => {
    const buffer = new TaskOutputBuffer(32, 16)
    for (let index = 0; index < 100; index += 1) buffer.push(`line-${index}\n`)
    expect(buffer.tail.length).toBeLessThanOrEqual(32)
    expect(buffer.tail).toContain('line-99')
    expect(buffer.tail).not.toContain('line-0\n')
  })

  it('flushes an unterminated last line and ignores blank separators', () => {
    const buffer = new TaskOutputBuffer(TASK_TAIL_BYTES, 1024)
    expect(buffer.push('one\n\n')).toEqual(['one'])
    expect(buffer.push('two without newline')).toEqual([])
    expect(buffer.finish()).toEqual(['two without newline'])
    expect(buffer.finish()).toEqual([])
  })

  it('emits an over-long terminated line as bounded pieces, not a truncated one', () => {
    const buffer = new TaskOutputBuffer(64, 8)
    const emitted = buffer.push(`${'abcdefgh'.repeat(4)}\n`)
    expect(emitted.join('')).toBe('abcdefgh'.repeat(4))
    expect(emitted.every((line) => line.length <= 8)).toBe(true)
    expect(buffer.finish()).toEqual([])
  })

  it('redacts through the same hook as the emitted events', () => {
    const buffer = new TaskOutputBuffer(200, 200, (text) => text.replace('secret', '***'))
    const emitted = buffer.push('token secret here\n')
    expect(emitted).toEqual(['token *** here'])
    expect(buffer.tail).not.toContain('secret')
  })
})

describe('task inventory snapshot', () => {
  function startVersionTask(): { manager: TaskManager; taskId: string; done: Promise<void> } {
    let settle: (() => void) | null = null
    const manager = new TaskManager((event) => {
      if (event.phase === 'end' || event.phase === 'error') settle?.()
    })
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const { taskId } = manager.start({
      kind: 'console',
      title: 'git version',
      args: ['version'],
      cwd: os.tmpdir(),
      repoPath: '/tmp/commit87-task-events'
    })
    return { manager, taskId, done }
  }

  it('lists a running task immediately and moves it to recent on completion', async () => {
    const { manager, taskId, done } = startVersionTask()
    const running = manager.snapshot()
    expect(running.running.map((entry) => entry.taskId)).toContain(taskId)
    expect(running.recent).toHaveLength(0)

    await done
    const snapshot = manager.snapshot()
    expect(snapshot.running).toHaveLength(0)
    const finished = snapshot.recent.find((entry) => entry.taskId === taskId)
    expect(finished?.phase).toBe('end')
    expect(finished?.repoPath).toBe('/tmp/commit87-task-events')
    expect(finished?.output).toContain('git version')
  })

  it('caps the recent inventory and drops the oldest entries', async () => {
    let settle: (() => void) | null = null
    const manager = new TaskManager((event) => {
      if (event.phase === 'end' || event.phase === 'error') settle?.()
    })
    const ids: string[] = []
    const run = (): Promise<void> =>
      new Promise<void>((resolve) => {
        settle = resolve
        const { taskId } = manager.start({
          kind: 'console',
          title: 'git version',
          args: ['version'],
          cwd: os.tmpdir()
        })
        ids.push(taskId)
      })
    for (let index = 0; index < TASK_RECENT_LIMIT + 2; index += 1) await run()

    const snapshot = manager.snapshot()
    expect(snapshot.recent).toHaveLength(TASK_RECENT_LIMIT)
    expect(snapshot.recent.map((entry) => entry.taskId)).toEqual(ids.slice(2))
  })
})

describe('task events carry the repository they belong to', () => {
  it('tags every phase of a task with repoPath', async () => {
    const repoPath = '/tmp/commit87-task-events'
    const events = await runTask(repoPath)
    expect(events.length).toBeGreaterThan(1)
    expect(events.every((event) => event.repoPath === repoPath)).toBe(true)
    expect(events[0].phase).toBe('start')
    expect(events.at(-1)?.phase).toBe('end')
  })

  it('leaves repoPath undefined for repository-less tasks', async () => {
    const events = await runTask(undefined)
    expect(events.every((event) => event.repoPath === undefined)).toBe(true)
  })
})

describe('task completion waits for post-run bookkeeping', () => {
  it('finishes exit bookkeeping before announcing the end event', async () => {
    const order: string[] = []
    const events = await runTask('/tmp/commit87-task-events', {
      onExit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push('bookkeeping')
      },
      onEvent: (event) => {
        if (event.phase === 'end') order.push('end')
      }
    })

    expect(order).toEqual(['bookkeeping', 'end'])
    expect(events.at(-1)?.phase).toBe('end')
  })

  it('still completes when exit bookkeeping fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const events = await runTask('/tmp/commit87-task-events', {
        onExit: () => {
          throw new Error('bookkeeping failed')
        }
      })
      expect(events.at(-1)?.phase).toBe('end')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
