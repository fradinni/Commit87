import type { GitGroveBridge } from '@shared/bridge'

/**
 * Reads the preload bridge from the global scope. `globalThis` is the renderer
 * window in production and a plain object in tests, so the store keeps no DOM
 * dependency.
 */
export function gitgroveBridge(): GitGroveBridge {
  const bridge = (globalThis as { gitgrove?: GitGroveBridge }).gitgrove
  if (!bridge) throw new Error('The GitGrove preload bridge is not available')
  return bridge
}
