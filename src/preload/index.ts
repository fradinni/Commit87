import { contextBridge, ipcRenderer } from 'electron'
import { IPC_INVOKE, IPC_MENU, IPC_TASK_EVENT, IPC_WINDOW_STATE } from '@shared/ipc'
import type { IpcChannel, IpcEnvelope, IpcRequest, IpcResponse, TaskEventEnvelope, WindowStateEvent } from '@shared/ipc'
import type { TaskEvent } from '@shared/types'

async function invoke<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResponse<K>> {
  const response = (await ipcRenderer.invoke(IPC_INVOKE, { channel, payload } satisfies IpcEnvelope<K>)) as {
    ok: boolean
    value?: IpcResponse<K>
    error?: string
  }
  if (!response.ok) throw new Error(response.error || 'Request failed')
  return response.value as IpcResponse<K>
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  invoke,
  onTaskEvent(callback: (event: TaskEvent) => void): () => void {
    return subscribe<TaskEventEnvelope>(IPC_TASK_EVENT, (envelope) => callback(envelope.event))
  },
  onWindowState(callback: (state: WindowStateEvent) => void): () => void {
    return subscribe<WindowStateEvent>(IPC_WINDOW_STATE, callback)
  },
  onMenu(callback: (action: string) => void): () => void {
    return subscribe<string>(IPC_MENU, callback)
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('gitgrove', api)

export type GitGroveApi = typeof api
