import type { IpcChannel, IpcRequest, IpcResponse, WindowStateEvent } from '@shared/ipc'
import type { TaskEvent } from '@shared/types'

export interface GitGroveBridge {
  invoke<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResponse<K>>
  onTaskEvent(callback: (event: TaskEvent) => void): () => void
  onWindowState(callback: (state: WindowStateEvent) => void): () => void
  onMenu(callback: (action: string) => void): () => void
  platform: string
  versions: { electron: string; chrome: string; node: string }
}

declare global {
  interface Window {
    gitgrove: GitGroveBridge
  }
}

export {}
