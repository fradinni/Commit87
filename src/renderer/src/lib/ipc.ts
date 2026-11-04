import type { IpcChannel, IpcMethods } from '@shared/ipc'

export function call<K extends IpcChannel>(
  channel: K,
  payload: IpcMethods[K]['request']
): Promise<IpcMethods[K]['response']> {
  return window.gitgrove.invoke(channel, payload)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
