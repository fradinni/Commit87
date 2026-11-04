import type { Commit } from '@shared/types'

export interface GraphNode {
  row: number
  lane: number
  color: string
  sha: string
  isMerge: boolean
}

export interface GraphEdge {
  d: string
  color: string
  fromRow: number
  toRow: number
  fromLane: number
  toLane: number
}

export interface GraphRow {
  commit: Commit
  lane: number
  color: string
  /** Lane index of each parent in the row below (missing parents are skipped). */
  parentLanes: number[]
}

export interface GraphLayout {
  rows: GraphRow[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  laneCount: number
  width: number
}

export const GRAPH_COLORS = ['#3ddc97', '#5ba8ff', '#c792ea', '#ffb86b', '#ff6b81', '#6be3e0', '#a3d977', '#f78fb3']

export const LANE_GAP = 14
export const GRAPH_PADDING = 10
const GRAPH_MIN_WIDTH = 36

interface Lane {
  sha: string
  color: number
}

/**
 * Assigns commits to vertical lanes.
 *
 * The important invariant is that a lane holds one pending commit sha and
 * never duplicates another lane. When a branch lines up with a lane that is
 * already open (the usual case for a merge whose second parent has already
 * been reached) the current lane is closed and the edge joins the existing
 * lane. The previous implementation kept both lanes, which left a stray line
 * running down the rest of the graph.
 */
export function buildGraph(commits: Commit[], rowHeight = 32): GraphLayout {
  const rows: GraphRow[] = []
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let lanes: Lane[] = []
  let laneCount = 1
  let colorSeq = 0

  const colorFor = (index: number): string => GRAPH_COLORS[index % GRAPH_COLORS.length]
  const xFor = (lane: number): number => GRAPH_PADDING + lane * LANE_GAP
  const yFor = (row: number): number => row * rowHeight + rowHeight / 2

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row]
    let lane = lanes.findIndex((item) => item.sha === commit.sha)
    if (lane === -1) {
      lane = lanes.length
      lanes.push({ sha: commit.sha, color: colorSeq++ })
    }

    const color = colorFor(lanes[lane].color)
    const before = lanes
    const after = lanes.map((item) => ({ ...item }))
    const parents = commit.parents

    if (parents.length === 0) {
      after.splice(lane, 1)
    } else {
      const firstParent = parents[0]
      const existing = after.findIndex((item, index) => index !== lane && item.sha === firstParent)
      if (existing === -1) {
        after[lane] = { sha: firstParent, color: before[lane].color }
      } else {
        // The first parent already owns a lane. Continue that line instead of
        // creating a second copy of the same pending commit.
        after.splice(lane, 1)
      }

      let insertAt = Math.min(lane + 1, after.length)
      for (const parent of parents.slice(1)) {
        if (after.some((item) => item.sha === parent)) continue
        after.splice(insertAt, 0, { sha: parent, color: colorSeq++ })
        insertAt += 1
      }
    }

    const parentLanes = parents
      .map((parent) => after.findIndex((item) => item.sha === parent))
      .filter((index) => index !== -1)

    rows.push({ commit, lane, color, parentLanes })
    nodes.push({ row, lane, color, sha: commit.sha, isMerge: parents.length > 1 })

    if (row < commits.length - 1) {
      for (let index = 0; index < before.length; index += 1) {
        const item = before[index]
        if (index === lane) {
          for (const target of parentLanes) {
            const targetLane = after[target]
            edges.push({
              d: curve(xFor(index), yFor(row), xFor(target), yFor(row + 1)),
              color: targetLane ? colorFor(targetLane.color) : color,
              fromRow: row,
              toRow: row + 1,
              fromLane: index,
              toLane: target
            })
          }
          continue
        }

        const target = after.findIndex((candidate) => candidate.sha === item.sha)
        if (target === -1) continue
        edges.push({
          d: curve(xFor(index), yFor(row), xFor(target), yFor(row + 1)),
          color: colorFor(after[target].color),
          fromRow: row,
          toRow: row + 1,
          fromLane: index,
          toLane: target
        })
      }
    }

    lanes = after
    laneCount = Math.max(laneCount, before.length, after.length, lane + 1)
  }

  return { rows, nodes, edges, laneCount, width: graphWidth(laneCount) }
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

export function graphWidth(laneCount: number): number {
  return Math.max(GRAPH_MIN_WIDTH, laneCount * LANE_GAP + 14)
}

export type RefKind = 'head' | 'branch' | 'tag' | 'remote'

export interface ClassifiedRef {
  name: string
  kind: RefKind
  current: boolean
}

const REF_RANK: Record<RefKind, number> = { head: 0, branch: 1, tag: 2, remote: 3 }

/**
 * Turns the decoration names from `git log --pretty=%D` into typed labels for
 * the branch/tag column. Tags and known local branches are checked before the
 * slash heuristic so `release/v1` is a tag and `feature/x` is a branch.
 */
export function classifyRefs(
  refs: string[],
  options: { tags?: ReadonlySet<string>; branches?: ReadonlySet<string>; currentBranch?: string | null } = {}
): ClassifiedRef[] {
  const seen = new Set<string>()
  const result: ClassifiedRef[] = []
  for (const name of refs) {
    if (!name || seen.has(name)) continue
    // `origin/HEAD` is a symbolic pointer to the remote default branch, not a
    // branch of its own; showing it would duplicate that branch's label.
    if (name !== 'HEAD' && name.endsWith('/HEAD')) continue
    seen.add(name)
    const current = Boolean(options.currentBranch && name === options.currentBranch)
    let kind: RefKind
    if (name === 'HEAD') kind = 'head'
    else if (options.tags?.has(name)) kind = 'tag'
    else if (current || options.branches?.has(name)) kind = 'branch'
    else if (name.includes('/')) kind = 'remote'
    else kind = 'branch'
    result.push({ name, kind, current })
  }
  return result.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    const rank = REF_RANK[a.kind] - REF_RANK[b.kind]
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  })
}
