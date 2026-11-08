import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import { TaskManager } from '../src/main/tasks'
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
