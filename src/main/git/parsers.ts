import type {
  BlameLine,
  Commit,
  DiffFileStat,
  RefInfo,
  RepoStatus,
  RepoInfo,
  StashInfo,
  StatusFile,
  TagInfo,
  WorktreeInfo
} from '@shared/types'

const FIELD = '\x1f'
const RECORD = '\x1e'

export function parseStatus(output: string): RepoStatus {
  let branch: string | null = null
  let headSha: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let detached = false
  const files: StatusFile[] = []

  const parts = output.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    let token = parts[i]
    if (!token) continue
    token = token.replace(/^\n+/, '')
    if (!token) continue
    if (token.startsWith('# ')) {
      const header = token.slice(2).trim()
      if (header.startsWith('branch.oid ')) {
        const value = header.slice('branch.oid '.length).trim()
        headSha = value === '(initial)' ? null : value
      } else if (header.startsWith('branch.head ')) {
        const value = header.slice('branch.head '.length).trim()
        detached = value === '(detached)'
        branch = detached ? null : value
      } else if (header.startsWith('branch.upstream ')) {
        upstream = header.slice('branch.upstream '.length).trim() || null
      } else if (header.startsWith('branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(header)
        if (match) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }

    const kind = token[0]
    if (kind === '1') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const path = fields.slice(8).join(' ')
      files.push(makeStatusFile(path, xy, undefined))
    } else if (kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const path = fields.slice(9).join(' ')
      const origPath = parts[i + 1] ?? undefined
      i += 1
      files.push(makeStatusFile(path, xy, origPath))
    } else if (kind === 'u') {
      const fields = token.split(' ')
      const xy = fields[1] ?? 'UU'
      const path = fields.slice(10).join(' ')
      files.push({
        path,
        index: xy[0] ?? 'U',
        worktree: xy[1] ?? 'U',
        stage: 'conflicted',
        label: 'Conflicted'
      })
    } else if (kind === '?') {
      const path = token.slice(2)
      files.push({
        path,
        index: '?',
        worktree: '?',
        stage: 'untracked',
        label: 'Untracked'
      })
    } else if (kind === '!') {
      // ignored
    }
  }

  const stagedCount = files.filter((f) => f.stage === 'staged').length
  const unstagedCount = files.filter((f) => f.stage === 'unstaged').length
  const untrackedCount = files.filter((f) => f.stage === 'untracked').length
  const conflictedCount = files.filter((f) => f.stage === 'conflicted').length

  return {
    branch,
    headSha,
    detached,
    upstream,
    ahead,
    behind,
    files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    clean: files.length === 0
  }
}

function makeStatusFile(path: string, xy: string, origPath: string | undefined): StatusFile {
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  let stage: StatusFile['stage']
  let label: string
  if (index !== '.' && worktree !== '.') {
    stage = 'staged'
    label = 'Staged + modified'
  } else if (index !== '.') {
    stage = 'staged'
    label = statusLabel(index)
  } else {
    stage = 'unstaged'
    label = statusLabel(worktree)
  }
  return { path, origPath, index, worktree, stage, label }
}

function statusLabel(code: string): string {
  switch (code) {
    case 'M':
      return 'Modified'
    case 'A':
      return 'Added'
    case 'D':
      return 'Deleted'
    case 'R':
      return 'Renamed'
    case 'C':
      return 'Copied'
    case 'T':
      return 'Type changed'
    case 'U':
      return 'Unmerged'
    case '?':
      return 'Untracked'
    default:
      return code === '.' ? 'Unchanged' : code
  }
}

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = []
  const records = output.split(RECORD)
  for (const record of records) {
    const trimmed = record.replace(/^\r?\n/, '')
    if (!trimmed.trim()) continue
    const fields = trimmed.split(FIELD)
    if (fields.length < 10) continue
    const [sha, parents, an, ae, at, cn, ce, ct, refs, subject] = fields
    const body = fields.slice(10).join(FIELD).trim()
    const authorDate = Number(at) * 1000
    const commitDate = Number(ct) * 1000
    commits.push({
      sha,
      shortSha: sha.slice(0, 8),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: { name: an, email: ae, date: authorDate },
      committer: { name: cn, email: ce, date: commitDate },
      subject,
      body,
      refs: parseDecoration(refs)
    })
  }
  return commits
}

export function parseDecoration(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith('HEAD -> ')) return item.slice('HEAD -> '.length)
      if (item === 'HEAD') return 'HEAD'
      if (item.startsWith('tag: ')) return item.slice('tag: '.length)
      return item
    })
}

export function parseBranches(output: string, currentBranch: string | null): RefInfo[] {
  const branches: RefInfo[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const f = line.split(FIELD)
    const refname = f[0] ?? ''
    if (!refname.startsWith('refs/heads/') && !refname.startsWith('refs/remotes/')) continue
    const isRemote = refname.startsWith('refs/remotes/')
    const shortName = refname.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
    if (isRemote && shortName.endsWith('/HEAD')) continue
    const track = f[3] ?? ''
    const aheadMatch = /ahead\s+(\d+)/.exec(track)
    const behindMatch = /behind\s+(\d+)/.exec(track)
    branches.push({
      name: refname,
      shortName,
      type: isRemote ? 'remote' : 'branch',
      sha: f[1] ?? '',
      upstream: f[2] || undefined,
      ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
      behind: behindMatch ? Number(behindMatch[1]) : 0,
      subject: f[4] ?? '',
      date: f[5] ? Number(f[5]) * 1000 : undefined,
      author: f[6] ?? undefined,
      isCurrent: !isRemote && shortName === currentBranch
    })
  }
  return branches
}

export function parseTags(output: string): TagInfo[] {
  const tags: TagInfo[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const f = line.split(FIELD)
    const name = f[0] ?? ''
    if (!name) continue
    const objectSha = f[1] ?? ''
    const objectType = f[2] ?? ''
    const deref = f[3] ?? ''
    const annotated = objectType === 'tag'
    const taggerName = f[5] ?? ''
    const taggerEmail = (f[6] ?? '').replace(/^<|>$/g, '')
    const taggerDate = Number(f[7] ?? '') * 1000
    const commitDate = Number(f[8] ?? '') * 1000
    const message = f.slice(9).join(FIELD).trim()
    tags.push({
      name,
      sha: objectSha,
      targetSha: annotated && deref ? deref : objectSha,
      annotated,
      subject: f[4] ?? message.split('\n')[0] ?? '',
      message: message || undefined,
      tagger: taggerName ? { name: taggerName, email: taggerEmail, date: taggerDate || commitDate } : undefined,
      date: Number.isFinite(commitDate) && commitDate > 0 ? commitDate : Number.isFinite(taggerDate) && taggerDate > 0 ? taggerDate : undefined
    })
  }
  return tags.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
}

export function parseWorktrees(output: string, currentPath: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = []
  const blocks = output.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    const info: WorktreeInfo = {
      path: '',
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: worktrees.length === 0,
      isCurrent: false
    }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) info.path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) info.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) info.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') info.bare = true
      else if (line === 'detached') info.detached = true
      else if (line.startsWith('locked')) {
        info.locked = true
        const reason = line.slice('locked'.length).trim()
        if (reason) info.lockReason = reason
      } else if (line.startsWith('prunable')) info.prunable = true
    }
    if (info.path) {
      info.isCurrent = normalizePath(info.path) === normalizePath(currentPath)
      worktrees.push(info)
    }
  }
  return worktrees
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function parseStashes(output: string): StashInfo[] {
  const stashes: StashInfo[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const f = line.split(FIELD)
    const selector = f[0] ?? ''
    const match = /stash@\{(\d+)\}/.exec(selector)
    if (!match) continue
    const message = f[2] ?? ''
    const branchMatch = /^(?:WIP on|On)\s+([^:]+):/.exec(message)
    stashes.push({
      index: Number(match[1]),
      sha: f[1] ?? '',
      message,
      branch: branchMatch ? branchMatch[1] : '',
      date: f[3] ? Number(f[3]) * 1000 : 0
    })
  }
  return stashes
}

export function parseNumstat(output: string): DiffFileStat[] {
  const files: DiffFileStat[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const f = line.split('\t')
    if (f.length < 3) continue
    const additions = f[0] === '-' ? 0 : Number(f[0])
    const deletions = f[1] === '-' ? 0 : Number(f[1])
    const path = f.slice(2).join('\t')
    files.push({
      path,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: f[0] === '-'
    })
  }
  return files
}

export function parseBlame(output: string): BlameLine[] {
  const lines: BlameLine[] = []
  const blocks = output.split(/\r?\n(?=[0-9a-f]{4,40} )/)
  for (const block of blocks) {
    if (!block.trim()) continue
    const header = block.split('\n')[0]?.split(' ') ?? []
    const sha = header[0] ?? ''
    const finalLine = Number(header[2] ?? '0')
    let author = ''
    let date = 0
    let content = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('author ')) author = line.slice(7)
      else if (line.startsWith('author-time ')) date = Number(line.slice(12)) * 1000
      else if (line.startsWith('\t')) content = line.slice(1)
    }
    if (sha && finalLine > 0) {
      lines.push({ sha, author, date, line: finalLine, content })
    }
  }
  return lines.sort((a, b) => a.line - b.line)
}

export interface ParsedRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export function parseRemotes(output: string): ParsedRemote[] {
  const map = new Map<string, ParsedRemote>()
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\S+)\t(.+?)\s+\((fetch|push)\)$/.exec(trimmed)
    if (!match) continue
    const [, name, url, kind] = match
    const existing = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') existing.fetchUrl = url
    else existing.pushUrl = url
    map.set(name, existing)
  }
  return [...map.values()].map((remote) => ({ ...remote, pushUrl: remote.pushUrl || remote.fetchUrl }))
}

export function parseConfig(output: string): Array<{ key: string; value: string; scope: 'local' | 'global' | 'system' }> {
  const entries: Array<{ key: string; value: string; scope: 'local' | 'global' | 'system' }> = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const scope = parts[0] === 'local' || parts[0] === 'global' || parts[0] === 'system' ? parts[0] : 'local'
    entries.push({ scope, key: parts[1], value: parts.slice(2).join('\t') })
  }
  return entries
}

export interface RawRepoInfo {
  root: string
  gitDir: string
  bare: boolean
  currentBranch: string | null
  headSha: string | null
  state: RepoInfo['state']
}

export function emptyStatus(): RepoStatus {
  return {
    branch: null,
    headSha: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true
  }
}
