/**
 * Widths of the panes the user can drag. Each pane is measured in CSS pixels,
 * clamped to its own bounds, and the splitter reserves room for the pane on the
 * other side so a drag cannot make that side unusable.
 */
export type PaneId = 'sidebar' | 'details' | 'staging' | 'fileTree'

export interface PaneBounds {
  /** Width used on first run, on reset and whenever nothing valid is stored. */
  defaultSize: number
  min: number
  max: number
}

export const PANE_BOUNDS: Record<PaneId, PaneBounds> = {
  sidebar: { defaultSize: 236, min: 180, max: 420 },
  details: { defaultSize: 380, min: 280, max: 760 },
  staging: { defaultSize: 350, min: 260, max: 720 },
  fileTree: { defaultSize: 280, min: 200, max: 560 }
}

/** Every pane, for the reset that drops all of the stored widths. */
export const PANE_IDS: PaneId[] = ['sidebar', 'details', 'staging', 'fileTree']

/**
 * The refs panel lists nested folders and needs more room than the navigation,
 * so it opens wider until the user picks a sidebar width of their own.
 */
export const REFS_SIDEBAR_WIDTH = 292

/** Announced on `window` after every stored width was dropped. */
export const PANES_RESET_EVENT = 'commit87:panes-reset'

/**
 * Round a requested width and keep it inside the pane's bounds. Callers pass a
 * range with `min <= max`; the splitter lowers the minimum itself when the
 * window leaves less room than the pane would normally allow.
 */
export function clampPaneSize(value: number, bounds: PaneBounds): number {
  if (!Number.isFinite(value)) return bounds.defaultSize
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

/** Read a stored width; returns null when nothing usable is stored. */
export function parsePaneSize(raw: string | null | undefined, bounds: PaneBounds): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? clampPaneSize(value, bounds) : null
}

/**
 * The width actually rendered: the chosen width, or the default for the current
 * mode, limited to what the window has room for. The chosen value itself is not
 * changed, so a window that grows again shows the width the user picked.
 * `room.min` is lowered when the window leaves less space than the pane's own
 * minimum, so the rendered width and the announced range always agree.
 */
export function visiblePaneSize(
  chosen: number | null,
  fallbackSize: number,
  room: { min: number; max: number }
): number {
  const base = chosen ?? fallbackSize
  const low = effectiveMinimum(room)
  return Math.min(Math.max(base, low), Math.max(low, room.max))
}

/**
 * The narrowest a pane may be in a given window. A container smaller than the
 * pane's own minimum lowers it, so the splitter can still shrink the pane to the
 * room that exists instead of forcing an overflow.
 */
export function effectiveMinimum(room: { min: number; max: number }): number {
  return Math.max(0, Math.min(room.min, room.max))
}

/**
 * Width of a pane in the middle of a drag: the pointer delta from where the
 * drag started, kept inside the pane's own bounds. `invert` is for a pane on the
 * right of its splitter. The window's own limit is applied by the caller as a
 * render clamp, so a drag never edits the remembered width invisibly.
 */
export function dragPaneSize(input: {
  startValue: number
  deltaX: number
  invert?: boolean
  bounds: PaneBounds
}): number {
  const delta = input.invert ? -input.deltaX : input.deltaX
  return clampPaneSize(input.startValue + delta, input.bounds)
}

/**
 * What a drag does to the pane: the width to render now, and the width to
 * remember when the drag ends. `remember` is null when the gesture did not move
 * the pane, so a nudge the window pins, or a drag that returns to where it
 * started, leaves the stored width alone. What is remembered is the width that
 * was actually on screen, never a wider value the window could not show.
 */
export function dragOutcome(input: {
  startVisible: number
  wanted: number
  room: { min: number; max: number }
}): { visible: number; remember: number | null } {
  const low = effectiveMinimum(input.room)
  const visible = Math.min(Math.max(input.wanted, low), Math.max(low, input.room.max))
  return { visible, remember: visible === input.startVisible ? null : visible }
}

/**
 * The pending value a drag carries between pointer moves. It is the width the
 * gesture currently stands on, or null while it stands on the start, so a move
 * that comes back to the start clears the pending width instead of leaving the
 * intermediate one to be committed on release.
 */
export function nextDragPending(previous: number | null, outcome: { remember: number | null }): number | null {
  return outcome.remember === null ? null : outcome.remember === previous ? previous : outcome.remember
}

export function paneStorageKey(id: PaneId): string {
  return `commit87.pane.${id}`
}