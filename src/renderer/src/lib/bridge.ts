import type { Commit87Bridge } from '@shared/bridge'

/**
 * Reads the preload bridge from the global scope. `globalThis` is the renderer
 * window in production and a plain object in tests, so the store keeps no DOM
 * dependency.
 */
export function commit87Bridge(): Commit87Bridge {
  const bridge = (globalThis as { commit87?: Commit87Bridge }).commit87
  if (!bridge) throw new Error('The Commit87 preload bridge is not available')
  return bridge
}
