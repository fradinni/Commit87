import type { Commit87Bridge } from '@shared/bridge'

export type { Commit87Bridge }

declare global {
  interface Window {
    commit87: Commit87Bridge
  }
}

export {}
