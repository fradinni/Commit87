import { describe, expect, it, vi } from 'vitest'
import { rememberRecentRepo } from '../src/main/recent'

const checkout = { path: '/work/alpha', name: 'alpha', worktree: false }
const linkedWorktree = { path: '/work/alpha-feature', name: 'alpha-feature', worktree: true }

describe('rememberRecentRepo', () => {
  it('adds a regular checkout to the recents', async () => {
    const addRecentRepo = vi.fn(async () => [])

    await rememberRecentRepo({ addRecentRepo }, checkout)

    expect(addRecentRepo).toHaveBeenCalledWith('/work/alpha', 'alpha')
  })

  it('skips a linked worktree opened from inside the app', async () => {
    const addRecentRepo = vi.fn(async () => [])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await rememberRecentRepo({ addRecentRepo }, linkedWorktree)
      await rememberRecentRepo({ addRecentRepo }, linkedWorktree, { standalone: false })

      expect(addRecentRepo).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('adds a linked worktree the system opened as a standalone repository', async () => {
    const addRecentRepo = vi.fn(async () => [])

    await rememberRecentRepo({ addRecentRepo }, linkedWorktree, { standalone: true })

    expect(addRecentRepo).toHaveBeenCalledWith('/work/alpha-feature', 'alpha-feature')
  })

  it('logs a failed write instead of failing the open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const addRecentRepo = vi.fn(async () => {
        throw new Error('read-only profile')
      })

      await expect(rememberRecentRepo({ addRecentRepo }, checkout)).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only profile'))
    } finally {
      warn.mockRestore()
    }
  })
})
