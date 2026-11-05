export type ConflictSide = 'normal' | 'ours' | 'base' | 'theirs'

export interface ConflictLine {
  text: string
  side: ConflictSide
  /** True for the "=======", "<<<<<<<", "|||||||" and ">>>>>>>" marker lines. */
  marker: boolean
}

/**
 * Split the working-tree content of an unmerged file into normal, ours, base
 * (diff3 style) and theirs lines. Git writes the markers at column zero, so
 * matching only the prefixes avoids treating indented code as a marker.
 */
export function parseConflictContent(content: string): ConflictLine[] {
  const lines: ConflictLine[] = []
  let side: ConflictSide = 'normal'
  let inConflict = false

  for (const text of content.split(/\r?\n/)) {
    if (text.startsWith('<<<<<<<')) {
      side = 'ours'
      inConflict = true
      lines.push({ text, side, marker: true })
      continue
    }
    if (inConflict && text.startsWith('|||||||')) {
      side = 'base'
      lines.push({ text, side, marker: true })
      continue
    }
    if (inConflict && text.startsWith('=======')) {
      side = 'theirs'
      lines.push({ text, side, marker: true })
      continue
    }
    if (inConflict && text.startsWith('>>>>>>>')) {
      lines.push({ text, side: 'normal', marker: true })
      side = 'normal'
      inConflict = false
      continue
    }
    lines.push({ text, side, marker: false })
  }

  return lines
}

export function hasConflictMarkers(lines: ConflictLine[]): boolean {
  return lines.some((line) => line.marker)
}
