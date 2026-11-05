export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'base' | 'none'

export interface ConflictRegion {
  /** Zero-based line index of the "<<<<<<<" marker. */
  start: number
  /** Zero-based line index of the ">>>>>>>" marker. */
  end: number
  oursLabel: string
  theirsLabel: string
  baseLabel: string | null
  ours: string[]
  base: string[] | null
  theirs: string[]
}

export interface ConflictParseResult {
  /** Working-tree lines with CRLF normalised to LF. */
  lines: string[]
  regions: ConflictRegion[]
  /** A marker pair is incomplete or an end marker has no start. */
  malformed: boolean
}

const START = '<<<<<<<'
const BASE = '|||||||'
const SEPARATOR = '======='
const END = '>>>>>>>'

/**
 * Split a file with conflict markers into regions. `applyConflictChoice` uses
 * the same line indices, so the two functions always agree on what a region is.
 */
export function parseConflicts(content: string): ConflictParseResult {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const regions: ConflictRegion[] = []
  let malformed = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.startsWith(START)) {
      if (line.startsWith(END)) malformed = true
      index += 1
      continue
    }

    const start = index
    let baseStart = -1
    let separator = -1
    let end = -1
    for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]
      if (baseStart < 0 && separator < 0 && candidate.startsWith(BASE)) {
        baseStart = cursor
      } else if (separator < 0 && candidate.startsWith(SEPARATOR)) {
        separator = cursor
      } else if (separator >= 0 && candidate.startsWith(END)) {
        end = cursor
        break
      } else if (candidate.startsWith(START)) {
        break
      }
    }

    if (separator < 0 || end < 0) {
      malformed = true
      index = start + 1
      continue
    }

    const oursEnd = baseStart >= 0 ? baseStart : separator
    regions.push({
      start,
      end,
      oursLabel: markerLabel(lines[start], START),
      theirsLabel: markerLabel(lines[end], END),
      baseLabel: baseStart >= 0 ? markerLabel(lines[baseStart], BASE) : null,
      ours: lines.slice(start + 1, oursEnd),
      base: baseStart >= 0 ? lines.slice(baseStart + 1, separator) : null,
      theirs: lines.slice(separator + 1, end)
    })
    index = end + 1
  }

  return { lines, regions, malformed }
}

export function applyConflictChoice(content: string, regionIndex: number, choice: ConflictChoice): string {
  const parsed = parseConflicts(content)
  const region = parsed.regions[regionIndex]
  if (!region) return content

  let replacement: string[]
  switch (choice) {
    case 'ours':
      replacement = region.ours
      break
    case 'theirs':
      replacement = region.theirs
      break
    case 'both':
      replacement = [...region.ours, ...region.theirs]
      break
    case 'base':
      replacement = region.base ?? region.ours
      break
    case 'none':
      replacement = []
      break
  }

  return [
    ...parsed.lines.slice(0, region.start),
    ...replacement,
    ...parsed.lines.slice(region.end + 1)
  ].join('\n')
}

export function hasUnresolvedConflicts(content: string): boolean {
  const parsed = parseConflicts(content)
  return parsed.regions.length > 0 || parsed.malformed
}

export function detectLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

export function withLineEndings(content: string, eol: '\n' | '\r\n'): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

function markerLabel(line: string, prefix: string): string {
  return line.slice(prefix.length).trim()
}
