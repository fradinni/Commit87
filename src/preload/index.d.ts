import type { GitGroveBridge } from '@shared/bridge'

export type { GitGroveBridge }

declare global {
  interface Window {
    gitgrove: GitGroveBridge
  }
}

export {}
