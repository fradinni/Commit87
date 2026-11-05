import type { IpcChannel, IpcRequest, IpcResponse, WindowStateEvent } from './ipc'
import type { TaskEvent, UpdateStatus } from './types'

/**
 * The complete surface the preload exposes on the renderer. Kept dependency-free
 * so both the preload typings and renderer tests can use it.
 */
export interface Commit87Bridge {
  invoke<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResponse<K>>
  onTaskEvent(callback: (event: TaskEvent) => void): () => void
  onWindowState(callback: (state: WindowStateEvent) => void): () => void
  onMenu(callback: (action: string) => void): () => void
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  platform: string
  versions: { electron: string; chrome: string; node: string }
}
