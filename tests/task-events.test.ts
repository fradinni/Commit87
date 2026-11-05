import { describe, expect, it } from 'vitest'
import os from 'node:os'
import { TaskManager } from '../src/main/tasks'
import type { TaskEvent } from '../src/shared/types'

function runTask(repoPath: string | undefined): Promise<TaskEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TaskEvent[] = []
    const timeout = setTimeout(() => reject(new Error('task did not finish')), 15000)
    const tasks = new TaskManager((event) => {
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
    tasks.start({ kind: 'console', title: 'git version', args: ['version'], cwd: os.tmpdir(), repoPath })
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
