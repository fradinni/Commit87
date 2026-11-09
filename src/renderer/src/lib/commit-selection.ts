export interface CommitSelectionState {
  /** Selected commits in graph order (newest first). */
  selected: string[]
  /** The commit whose details are shown; always one of `selected` when set. */
  active: string | null
  /** The commit a Shift range starts from. */
  anchor: string | null
}

export interface CommitSelectionModifiers {
  /** Ctrl/Cmd: add or remove this commit without clearing the rest. */
  toggle?: boolean
  /** Shift: select every commit between the anchor and this one. */
  range?: boolean
}

function inGraphOrder(order: readonly string[], wanted: Iterable<string>): string[] {
  const selected = new Set(wanted)
  return order.filter((sha) => selected.has(sha))
}

function nearestSelected(order: readonly string[], selected: string[], removedIndex: number): string | null {
  if (!selected.length) return null
  const wanted = new Set(selected)
  for (let index = removedIndex + 1; index < order.length; index += 1) {
    if (wanted.has(order[index])) return order[index]
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    if (wanted.has(order[index])) return order[index]
  }
  return selected[0] ?? null
}

/**
 * Apply a click to the current selection. A plain click replaces it, Ctrl/Cmd
 * toggles one commit, Shift selects the range from the anchor, and Ctrl/Cmd+Shift
 * adds that range to the existing selection.
 */
export function applyCommitSelection(
  order: readonly string[],
  state: CommitSelectionState,
  sha: string,
  modifiers: CommitSelectionModifiers = {}
): CommitSelectionState {
  const index = order.indexOf(sha)
  if (index < 0) return state

  if (modifiers.range) {
    const anchor =
      state.anchor && order.includes(state.anchor)
        ? state.anchor
        : state.active && order.includes(state.active)
          ? state.active
          : sha
    const anchorIndex = order.indexOf(anchor)
    const start = Math.min(anchorIndex, index)
    const end = Math.max(anchorIndex, index)
    const range = order.slice(start, end + 1)
    return {
      selected: modifiers.toggle ? inGraphOrder(order, [...state.selected, ...range]) : range,
      active: sha,
      anchor
    }
  }

  if (modifiers.toggle) {
    if (state.selected.includes(sha)) {
      const selected = inGraphOrder(order, state.selected.filter((item) => item !== sha))
      return {
        selected,
        active:
          state.active === sha
            ? nearestSelected(order, selected, index)
            : state.active && selected.includes(state.active)
              ? state.active
              : selected[selected.length - 1] ?? null,
        anchor: sha
      }
    }
    return { selected: inGraphOrder(order, [...state.selected, sha]), active: sha, anchor: sha }
  }

  return { selected: [sha], active: sha, anchor: sha }
}

/** Keep only commits that are still loaded, preserving graph order. */
export function normalizeCommitSelection(order: readonly string[], selected: Iterable<string>): string[] {
  return inGraphOrder(order, selected)
}

/**
 * Reconcile a selection with a changed graph list. Returns null when nothing
 * changes. An active commit that was never loaded (for example a jump from the
 * refs panel) is kept; one that was loaded before and has disappeared falls
 * back to the first surviving commit.
 */
export function reconcileCommitSelection(
  order: readonly string[],
  previousOrder: readonly string[],
  state: CommitSelectionState
): CommitSelectionState | null {
  if (!state.active) {
    if (!state.selected.length) return null
    return { selected: [], active: null, anchor: null }
  }
  if (!order.includes(state.active)) {
    if (!previousOrder.includes(state.active)) return null
    const stillLoaded = inGraphOrder(order, state.selected)
    const active = stillLoaded[0] ?? null
    return { selected: stillLoaded, active, anchor: active }
  }
  const stillLoaded = inGraphOrder(order, state.selected)
  if (stillLoaded.length === state.selected.length) return null
  const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : state.active
  return { selected: stillLoaded, active: state.active, anchor }
}

/**
 * Return the selected commits in the order a history action must replay them.
 * The graph lists newest first, so cherry-pick walks oldest first (like a range)
 * while revert walks newest first to avoid reverting a commit before its children.
 */
export function orderSelectedCommits(
  order: readonly string[],
  selected: Iterable<string>,
  action: 'cherry-pick' | 'revert'
): string[] {
  const commits = inGraphOrder(order, selected)
  return action === 'cherry-pick' ? commits.reverse() : commits
}
