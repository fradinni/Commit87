import { describe, expect, it } from 'vitest'
import {
  applyCommitSelection,
  normalizeCommitSelection,
  orderSelectedCommits,
  reconcileCommitSelection
} from '../src/renderer/src/lib/commit-selection'
import type { CommitSelectionState } from '../src/renderer/src/lib/commit-selection'

const order = ['e', 'd', 'c', 'b', 'a']

const state = (selected: string[], active: string | null, anchor: string | null): CommitSelectionState => ({
  selected,
  active,
  anchor
})

describe('commit selection', () => {
  it('replaces the selection on a plain click', () => {
    expect(applyCommitSelection(order, state(['e', 'd'], 'e', 'e'), 'b')).toEqual(
      state(['b'], 'b', 'b')
    )
  })

  it('adds a commit with Ctrl/Cmd and keeps graph order', () => {
    expect(applyCommitSelection(order, state(['c'], 'c', 'c'), 'e', { toggle: true })).toEqual(
      state(['e', 'c'], 'e', 'e')
    )
  })

  it('removes a toggled commit and moves the active one to its nearest neighbour', () => {
    expect(applyCommitSelection(order, state(['e', 'c', 'b'], 'c', 'e'), 'c', { toggle: true })).toEqual(
      state(['e', 'b'], 'b', 'c')
    )
    expect(applyCommitSelection(order, state(['a'], 'a', 'a'), 'a', { toggle: true })).toEqual(
      state([], null, 'a')
    )
  })

  it('keeps the active commit when a background commit is toggled off', () => {
    expect(applyCommitSelection(order, state(['e', 'c', 'b'], 'e', 'e'), 'c', { toggle: true })).toEqual(
      state(['e', 'b'], 'e', 'c')
    )
  })

  it('selects an inclusive range from the anchor on Shift-click', () => {
    expect(applyCommitSelection(order, state(['c'], 'c', 'c'), 'a', { range: true })).toEqual(
      state(['c', 'b', 'a'], 'a', 'c')
    )
  })

  it('keeps the anchor across repeated Shift-clicks and ranges both directions', () => {
    const first = applyCommitSelection(order, state(['c', 'b', 'a'], 'a', 'c'), 'd', { range: true })
    expect(first).toEqual(state(['d', 'c'], 'd', 'c'))
    const second = applyCommitSelection(order, first, 'e', { range: true })
    expect(second).toEqual(state(['e', 'd', 'c'], 'e', 'c'))
  })

  it('adds a range without clearing the existing selection with Ctrl/Cmd+Shift', () => {
    expect(
      applyCommitSelection(order, state(['a'], 'a', 'e'), 'c', { range: true, toggle: true })
    ).toEqual(state(['e', 'd', 'c', 'a'], 'c', 'e'))
  })

  it('falls back to the active commit when the anchor is no longer loaded', () => {
    expect(applyCommitSelection(order, state(['c'], 'c', 'missing'), 'b', { range: true })).toEqual(
      state(['c', 'b'], 'b', 'c')
    )
  })

  it('ignores a click on a commit that is not loaded', () => {
    const before = state(['b'], 'b', 'b')
    expect(applyCommitSelection(order, before, 'missing')).toBe(before)
  })

  it('keeps only loaded commits in graph order', () => {
    expect(normalizeCommitSelection(order, ['a', 'missing', 'c'])).toEqual(['c', 'a'])
    expect(normalizeCommitSelection([], ['a'])).toEqual([])
  })

  it('replays cherry-pick oldest first and revert newest first', () => {
    expect(orderSelectedCommits(order, ['e', 'c', 'a'], 'cherry-pick')).toEqual(['a', 'c', 'e'])
    expect(orderSelectedCommits(order, ['e', 'c', 'a'], 'revert')).toEqual(['e', 'c', 'a'])
    expect(orderSelectedCommits(order, [], 'cherry-pick')).toEqual([])
  })

  it('ignores selected SHAs that are no longer loaded when ordering actions', () => {
    expect(orderSelectedCommits(order, ['missing', 'c', 'also-missing', 'a'], 'cherry-pick')).toEqual(['a', 'c'])
    expect(orderSelectedCommits(order, ['missing', 'c', 'a'], 'revert')).toEqual(['c', 'a'])
  })
})

describe('commit selection reconciliation', () => {
  it('drops selected commits that disappeared while keeping the active one', () => {
    expect(
      reconcileCommitSelection(['e', 'c'], order, state(['e', 'c', 'a'], 'c', 'e'))
    ).toEqual(state(['e', 'c'], 'c', 'e'))
    expect(reconcileCommitSelection(order, order, state(['e', 'c'], 'c', 'e'))).toBeNull()
  })

  it('falls back to a surviving commit when the active commit was removed', () => {
    expect(reconcileCommitSelection(['d', 'b'], order, state(['e', 'b'], 'e', 'e'))).toEqual(
      state(['b'], 'b', 'b')
    )
    expect(reconcileCommitSelection(['d'], order, state(['e'], 'e', 'e'))).toEqual(
      state([], null, null)
    )
  })

  it('keeps an active commit that was never part of the loaded list', () => {
    expect(reconcileCommitSelection(order, [], state([], 'external', null))).toBeNull()
  })

  it('clears a selection that has no active commit', () => {
    expect(reconcileCommitSelection(order, order, state(['c', 'a'], null, null))).toEqual(
      state([], null, null)
    )
    expect(reconcileCommitSelection(order, order, state([], null, null))).toBeNull()
  })
})