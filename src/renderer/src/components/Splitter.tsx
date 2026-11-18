import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  clampPaneSize,
  dragOutcome,
  dragPaneSize,
  effectiveMinimum,
  nextDragPending,
  PANE_BOUNDS,
  PANE_IDS,
  PANES_RESET_EVENT,
  paneStorageKey,
  parsePaneSize,
  visiblePaneSize,
  type PaneId
} from '../lib/panes'

/** Width of the drag handle itself, kept in step with `.splitter` in app.css. */
const HANDLE_WIDTH = 10
/** Keyboard resize step, larger with Shift held. */
const RESIZE_STEP = 16
const RESIZE_STEP_LARGE = 64

function storageOf(): Storage | null {
  try {
    return window.localStorage
  } catch (error) {
    // Blocked storage only costs the remembered width, never the pane.
    console.warn('[commit87] pane widths are not available', error)
    return null
  }
}

function storedSize(id: PaneId): number | null {
  const storage = storageOf()
  if (!storage) return null
  try {
    return parsePaneSize(storage.getItem(paneStorageKey(id)), PANE_BOUNDS[id])
  } catch (error) {
    // A disabled storage only costs the remembered width; the pane still works.
    console.warn('[commit87] could not read a pane width', error)
    return null
  }
}

/**
 * Forget every remembered width so the next render uses the defaults. Storage
 * failures are reported but still reset the panes already mounted.
 */
export function resetPaneSizes(): void {
  const storage = storageOf()
  if (storage) {
    for (const id of PANE_IDS) {
      try {
        storage.removeItem(paneStorageKey(id))
      } catch (error) {
        console.warn('[commit87] could not drop a pane width', error)
      }
    }
  }
  window.dispatchEvent(new Event(PANES_RESET_EVENT))
}

/**
 * Width of one draggable pane, remembered across restarts. Until the user picks
 * a width the pane uses `fallbackSize`, so a mode that needs more room (the refs
 * panel) can open wide and still follow a single drag for both modes.
 * `setSize` clamps to the pane's bounds and stores the result. `fit` reports how
 * wide the pane may be in the current window; it limits the render only, so
 * widening the window brings back the width the user chose.
 */
export function usePaneSize(
  id: PaneId,
  fallbackSize = PANE_BOUNDS[id].defaultSize
): {
  size: number
  setSize: (next: number) => void
  reset: () => void
  /** Reports the room the window leaves: a lowered minimum and the ceiling. */
  fit: (min: number, max: number) => void
} {
  const bounds = PANE_BOUNDS[id]
  const [chosen, setChosen] = useState<number | null>(() => storedSize(id))
  const [room, setRoom] = useState({ min: bounds.min, max: bounds.max })
  const size = visiblePaneSize(chosen, fallbackSize, room)

  const setSize = useCallback(
    (next: number) => {
      const clamped = clampPaneSize(next, bounds)
      setChosen(clamped)
      const storage = storageOf()
      if (!storage) return
      try {
        storage.setItem(paneStorageKey(id), String(clamped))
      } catch (error) {
        // A quota or disabled storage only costs the remembered width.
        console.warn('[commit87] could not remember a pane width', error)
      }
    },
    [bounds, id]
  )

  // Forgetting the chosen width is the double-click gesture and the reset: the
  // pane goes back to the default for its current mode.
  const reset = useCallback(() => {
    setChosen(null)
    const storage = storageOf()
    if (!storage) return
    try {
      storage.removeItem(paneStorageKey(id))
    } catch (error) {
      console.warn('[commit87] could not drop a pane width', error)
    }
  }, [id])

  const fit = useCallback((min: number, max: number) => {
    setRoom((current) => (current.min === min && current.max === max ? current : { min, max }))
  }, [])

  // "Reset pane widths" drops the stored values; the panes already mounted
  // follow the defaults without a reload.
  useEffect(() => {
    window.addEventListener(PANES_RESET_EVENT, reset)
    return () => window.removeEventListener(PANES_RESET_EVENT, reset)
  }, [reset])

  return { size, setSize, reset, fit }
}

/**
 * Vertical divider between two columns. `value` belongs to the pane being
 * sized; `invert` is for a pane on the right of the divider, where dragging
 * left has to grow it.
 */
export function Splitter({
  id,
  value,
  onChange,
  onFit,
  onReset,
  controls,
  invert = false,
  reserve = 240,
  label
}: {
  id: PaneId
  value: number
  onChange: (next: number) => void
  /** Reports how wide this pane may be in the current window. */
  onFit: (min: number, max: number) => void
  /** Double-click: forget the chosen width and go back to the default. */
  onReset: () => void
  /** Element id of the pane this handle sizes, so assistive tech can find it. */
  controls: string
  invert?: boolean
  /** Space the opposite pane keeps when measuring how far this one may grow. */
  reserve?: number
  label: string
}) {
  const bounds = PANE_BOUNDS[id]
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startValue: number; last: number | null } | null>(null)
  const [max, setMax] = useState(bounds.max)
  const [min, setMin] = useState(bounds.min)
  const [dragging, setDragging] = useState(false)

  // The window can be narrower than the stored width plus the opposite pane's
  // minimum, so the allowed range follows the container instead of the static
  // bounds alone. Measuring before paint keeps a too-wide pane from being drawn
  // for one frame.
  useLayoutEffect(() => {
    const parent = handleRef.current?.parentElement
    if (!parent) return undefined
    const measure = (): void => {
      const room = parent.clientWidth - reserve - HANDLE_WIDTH
      // A window with less room than the pane usually needs shrinks it instead
      // of clipping the pane and the content beside it.
      const ceiling = Math.max(0, Math.min(bounds.max, Math.floor(room)))
      const floor = effectiveMinimum({ min: bounds.min, max: ceiling })
      setMax(ceiling)
      setMin(floor)
      onFit(floor, ceiling)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [bounds.max, bounds.min, onFit, reserve])

  // Keep the resize cursor and kill text selection for the whole drag, even
  // when the pointer leaves the handle. A lost window (alt-tab, a screen lock)
  // can swallow the pointerup, so the drag also ends on blur; otherwise the body
  // would keep the resize cursor and the pane could keep an uncommitted width.
  useEffect(() => {
    if (!dragging) return undefined
    document.body.dataset.paneResizing = 'horizontal'
    const commit = (): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setDragging(false)
      if (drag.last !== null) onChange(drag.last)
    }
    window.addEventListener('blur', commit)
    return () => {
      window.removeEventListener('blur', commit)
      delete document.body.dataset.paneResizing
    }
  }, [dragging, onChange])

  const clamp = useCallback(
    (next: number) => clampPaneSize(next, { defaultSize: bounds.defaultSize, min, max }),
    [bounds.defaultSize, max, min]
  )

  /** The pane this handle sizes: the column before it, or after it when inverted. */
  const paneElement = (): HTMLElement | null => {
    const handle = handleRef.current
    if (!handle) return null
    const sibling = invert ? handle.nextElementSibling : handle.previousElementSibling
    return sibling instanceof HTMLElement ? sibling : null
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    // preventDefault suppresses focus, but the arrow keys should keep working.
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, startValue: value, last: null }
    setDragging(true)
  }

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    // A release the handle never saw (the pointer left the window, the OS took
    // the gesture) ends the drag here instead of leaving it stuck.
    if (event.buttons === 0) {
      finishResize(event)
      return
    }
    // Every move is measured from the drag start, so returning the pointer
    // restores the width it began with. The width is written straight to the
    // pane during the drag: a pointer move must not re-render the list or the
    // commit graph behind it, nor touch storage.
    const deltaX = event.clientX - drag.startX
    const wanted = dragPaneSize({ startValue: drag.startValue, deltaX, invert, bounds })
    const outcome = dragOutcome({ startVisible: drag.startValue, wanted, room: { min, max } })
    // Only a gesture that moved the pane changes the remembered width, and a
    // gesture that returns to where it started clears it again: a nudge the
    // window pins must not rewrite a value the user cannot see change.
    drag.last = nextDragPending(drag.last, outcome)
    const pane = paneElement()
    if (pane) pane.style.width = `${outcome.visible}px`
  }

  /** Undo the drag in place: the pane goes back to the width React renders. */
  const restorePane = (): void => {
    const pane = paneElement()
    if (pane) pane.style.width = `${value}px`
  }

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // Hand the width React would have rendered back before committing, so a
    // drag that moved and returned leaves no stray inline width behind.
    restorePane()
    if (drag.last !== null) onChange(drag.last)
  }

  /** A cancelled gesture is not a choice: keep the width it started with. */
  const cancelResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    restorePane()
  }

  const apply = (next: number): void => {
    const clamped = clamp(next)
    if (clamped !== value) onChange(clamped)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = value + (invert ? step : -step)
    else if (event.key === 'ArrowRight') next = value + (invert ? -step : step)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    apply(next)
  }

  return (
    <div
      ref={handleRef}
      className={`splitter ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={`${Math.round(value)} pixels`}
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={cancelResize}
      onLostPointerCapture={finishResize}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span className="splitter-grip" />
    </div>
  )
}