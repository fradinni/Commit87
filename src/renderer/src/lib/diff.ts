export type DiffLineType = 'context' | 'add' | 'del' | 'meta'

export interface DiffLine {
  type: DiffLineType
  oldNumber: number | null
  newNumber: number | null
  text: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedDiffFile {
  oldPath: string
  newPath: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'changed'
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export function parsePatch(patch: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = []
  if (!patch.trim()) return files
  const lines = patch.split(/\r?\n/)
  let current: ParsedDiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const finishHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk)
    hunk = null
  }
  const finishFile = (): void => {
    finishHunk()
    if (current) files.push(current)
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishFile()
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = {
        oldPath: match?.[1] ?? '',
        newPath: match?.[2] ?? match?.[1] ?? '',
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('new file mode')) {
      current.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed'
      current.oldPath = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      current.oldPath = current.oldPath || current.newPath
      current.newPath = line.slice('rename to '.length)
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true
      current.status = 'binary'
      continue
    }
    if (line.startsWith('--- ')) {
      if (line !== '--- /dev/null') current.oldPath = stripPrefix(line.slice(4))
      else current.oldPath = ''
      continue
    }
    if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') current.newPath = stripPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('@@')) {
      finishHunk()
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      oldNo = Number(match?.[1] ?? 1)
      newNo = Number(match?.[2] ?? 1)
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', oldNumber: null, newNumber: newNo++, text: line.slice(1) })
      current.additions += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', oldNumber: oldNo++, newNumber: null, text: line.slice(1) })
      current.deletions += 1
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', oldNumber: null, newNumber: null, text: line.slice(1) })
    } else {
      hunk.lines.push({ type: 'context', oldNumber: oldNo++, newNumber: newNo++, text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  finishFile()
  return files
}

function stripPrefix(value: string): string {
  return value.replace(/^[ab]\//, '').replace(/\t.*$/, '')
}

export function patchLineCount(patch: string): number {
  return patch ? patch.split(/\r?\n/).length : 0
}
