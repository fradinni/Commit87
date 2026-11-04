import type { Commit } from '@shared/types'

export interface GraphNode {
  row: number
  lane: number
  color: string
  sha: string
}

export interface GraphEdge {
  d: string
  color: string
}

export interface GraphRow {
  commit: Commit
  lane: number
  color: string
}

export interface GraphLayout {
  rows: GraphRow[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  laneCount: number
}

export const GRAPH_COLORS = ['#3ddc97', '#5ba8ff', '#c792ea', '#ffb86b', '#ff6b81', '#6be3e0', '#a3d977', '#f78fb3']

export function buildGraph(commits: Commit[], rowHeight = 34): GraphLayout {
  const rows: GraphRow[] = []
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let lanes: Array<string | null> = []
  let laneCount = 1

  const yFor = (row: number): number => row * rowHeight + rowHeight / 2
  const xFor = (lane: number): number => lane * 16 + 12

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row]
    let lane = lanes.indexOf(commit.sha)
    if (lane === -1) {
      lane = lanes.findIndex((item) => item === null)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(commit.sha)
      } else {
        lanes[lane] = commit.sha
      }
    }
    const color = GRAPH_COLORS[lane % GRAPH_COLORS.length]
    rows.push({ commit, lane, color })
    nodes.push({ row, lane, color, sha: commit.sha })

    const before = [...lanes]
    const after = [...lanes]
    after[lane] = commit.parents[0] ?? null
    let insertAt = lane + 1
    for (const parent of commit.parents.slice(1)) {
      if (!after.includes(parent)) {
        after.splice(insertAt, 0, parent)
        insertAt += 1
      }
    }
    // Collapse consecutive empty lanes at the end.
    while (after.length && after[after.length - 1] === null) after.pop()

    const nextLanes = after
    for (let i = 0; i < before.length; i += 1) {
      const sha = before[i]
      if (!sha) continue
      if (sha === commit.sha) {
        for (const parent of commit.parents) {
          const target = nextLanes.indexOf(parent)
          if (target === -1) continue
          edges.push({
            d: curve(xFor(i), yFor(row), xFor(target), yFor(row + 1)),
            color: GRAPH_COLORS[target % GRAPH_COLORS.length]
          })
        }
      } else {
        const target = nextLanes.indexOf(sha)
        if (target === -1) continue
        edges.push({
          d: curve(xFor(i), yFor(row), xFor(target), yFor(row + 1)),
          color: GRAPH_COLORS[target % GRAPH_COLORS.length]
        })
      }
    }
    lanes = nextLanes
    laneCount = Math.max(laneCount, before.length, nextLanes.length, lane + 1)
  }

  return { rows, nodes, edges, laneCount }
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

export function graphWidth(laneCount: number): number {
  return Math.max(28, laneCount * 16 + 16)
}
