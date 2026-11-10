import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { runGit, setGitBinary } from '../src/main/git/runner'
import {
  getStatus,
  invalidateRepoDiscovery,
  repoDiscoveryMetrics,
  resetRepoDiscoveryMetrics,
  resolveRepo
} from '../src/main/git/repo'
import { normalizePath } from '../src/main/git/parsers'

const created: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

async function initRepo(): Promise<string> {
  const dir = await fs.realpath(await tempDir('commit87-discovery-'))
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir })
  await runGit(['config', 'user.name', 'Discovery Test'], { cwd: dir })
  await runGit(['config', 'user.email', 'discovery@example.com'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'one\n')
  await runGit(['add', 'tracked.txt'], { cwd: dir })
  await runGit(['commit', '-q', '-m', 'first'], { cwd: dir })
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('repository discovery cache', () => {
  it('reuses stable facts but still reads external branch and status changes', async () => {
    const dir = await initRepo()
    const first = await resolveRepo(dir)
    expect(first.currentBranch).toBe('main')
    const firstStatus = await getStatus(dir)
    expect(firstStatus.clean).toBe(true)

    // Re-resolve with nothing changing: the stable part comes from the cache.
    resetRepoDiscoveryMetrics()
    const second = await resolveRepo(dir)
    expect(second.root).toBe(first.root)
    expect(second.gitDir).toBe(first.gitDir)
    expect(second.commonDir).toBe(first.commonDir)
    expect(repoDiscoveryMetrics.cacheHits).toBeGreaterThan(0)
    const cachedSpawns = repoDiscoveryMetrics.spawns
    // Stable discovery is at most the two one-time `rev-parse` calls, never
    // the per-marker operation probes plus a second stable read.
    expect(cachedSpawns).toBeLessThanOrEqual(4)

    // An external change is visible on the next read; nothing dynamic is cached.
    await runGit(['switch', '-q', '-c', 'external-branch'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'x\n')
    const third = await resolveRepo(dir)
    expect(third.currentBranch).toBe('external-branch')
    expect(third.path).toBe(first.path)
    expect(third.gitDir).toBe(first.gitDir)
    const dirty = await getStatus(dir)
    expect(dirty.branch).toBe('external-branch')
    expect(dirty.clean).toBe(false)
    expect(dirty.untrackedCount).toBe(1)
  })

  it('reflects an external merge/reset operation state on every read', async () => {
    const dir = await initRepo()
    expect((await resolveRepo(dir)).state).toBe('clean')
    await runGit(['switch', '-q', '-c', 'side'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'side.txt'), 'side\n')
    await runGit(['add', 'side.txt'], { cwd: dir })
    await runGit(['commit', '-q', '-m', 'side'], { cwd: dir })
    await runGit(['switch', '-q', 'main'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'main.txt'), 'main\n')
    await runGit(['add', 'main.txt'], { cwd: dir })
    await runGit(['commit', '-q', '-m', 'main'], { cwd: dir })
    const merge = await runGit(['merge', 'side'], { cwd: dir, allowFailure: true })
    expect(merge.exitCode).toBe(0)

    // Create a real conflict so the pending operation is on disk.
    await runGit(['switch', '-q', '-c', 'conflict-a', 'HEAD~1'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'a\n')
    await runGit(['commit', '-q', '-am', 'a'], { cwd: dir })
    await runGit(['switch', '-q', 'main'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'b\n')
    await runGit(['commit', '-q', '-am', 'b'], { cwd: dir })
    const conflict = await runGit(['merge', 'conflict-a'], { cwd: dir, allowFailure: true })
    expect(conflict.exitCode).not.toBe(0)

    const merging = await resolveRepo(dir)
    expect(merging.state).toBe('merging')
    await runGit(['merge', '--abort'], { cwd: dir })
    expect((await resolveRepo(dir)).state).toBe('clean')
  })

  it('drops cached facts when a folder is invalidated or stops being a repository', async () => {
    const dir = await initRepo()
    await resolveRepo(dir)
    resetRepoDiscoveryMetrics()
    invalidateRepoDiscovery(dir)
    const again = await resolveRepo(dir)
    // Git reports forward slashes on Windows; compare in normalized form.
    expect(normalizePath(again.root)).toBe(normalizePath(await fs.realpath(dir)))
    // An invalidated repository pays one fresh discovery (two processes).
    expect(repoDiscoveryMetrics.cacheHits).toBe(0)
    expect(repoDiscoveryMetrics.spawns).toBeGreaterThanOrEqual(2)

    // A deleted checkout cannot be served from the cache.
    const gone = await tempDir('commit87-discovery-gone-')
    const nested = path.join(gone, 'repo')
    await fs.mkdir(nested)
    await runGit(['init', '-q'], { cwd: nested })
    await resolveRepo(nested)
    await fs.rm(nested, { recursive: true, force: true })
    await expect(resolveRepo(nested)).rejects.toThrow('Path does not exist')
  })

  // A counting Git wrapper makes the cost a number instead of a timing, so the
  // assertion is deterministic. The wrapper is a POSIX shell script, so it only
  // runs on the platform CI uses.
  it.skipIf(process.platform === 'win32')('spends far fewer processes on a cached resolve and a status poll', async () => {
    const dir = await initRepo()
    const log = path.join(os.tmpdir(), `commit87-spawns-${process.pid}.log`)
    const wrapper = path.join(os.tmpdir(), `commit87-git-wrapper-${process.pid}.sh`)
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    await fs.writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec ${realGit} "$@"\n`, { mode: 0o755 })
    const count = async (run: () => Promise<unknown>): Promise<number> => {
      await fs.rm(log, { force: true })
      await run()
      return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).length
    }
    setGitBinary(wrapper)
    try {
      // A first resolve pays for stable discovery; later ones reuse it.
      const cold = await count(() => resolveRepo(dir))
      const warm = await count(() => resolveRepo(dir))
      // The 5 s poll asks for repository info and status at the same time.
      const poll = await count(() => Promise.all([resolveRepo(dir), getStatus(dir)]))
      expect(warm).toBeLessThan(cold)
      expect(warm).toBeLessThanOrEqual(4)
      expect(poll).toBeLessThanOrEqual(4)
    } finally {
      setGitBinary(null)
      await fs.rm(wrapper, { force: true }).catch(() => undefined)
      await fs.rm(log, { force: true }).catch(() => undefined)
    }
  })

  it('shares one read between concurrent resolves of the same checkout', async () => {
    const dir = await initRepo()
    await resolveRepo(dir)
    resetRepoDiscoveryMetrics()
    const [left, right] = await Promise.all([resolveRepo(dir), resolveRepo(dir)])
    expect(left.gitDir).toBe(right.gitDir)
    expect(repoDiscoveryMetrics.calls).toBe(2)
    // The second caller joined the first call's work instead of spawning again.
    expect(repoDiscoveryMetrics.cacheHits).toBe(1)
  })
})