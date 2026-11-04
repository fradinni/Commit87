import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import path from 'node:path'
import { IPC_INVOKE, IPC_MENU, IPC_TASK_EVENT } from '@shared/ipc'
import type { IpcChannel, IpcEnvelope } from '@shared/ipc'
import { AppStore } from './store'
import { TaskManager } from './tasks'
import { ProviderService } from './providers/service'
import { Router } from './ipc/router'
import { createMainWindow } from './window'
import { installMenu } from './menu'
import { registerAppProtocol, registerAppScheme } from './protocol'

app.setName('GitGrove')
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.gitgrove.GitGrove')
}

registerAppScheme()

// A single instance keeps repo state, tasks and the credential store coherent.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let store: AppStore
let router: Router
let pendingDeepLink: string | null = null

/** Accepts `gitgrove://open?path=…`, `gitgrove:///abs/path` and plain folder argv. */
function parseLaunchTarget(argv: string[], cwd: string): string | null {
  for (const raw of argv) {
    if (!raw || raw.startsWith('-')) continue
    if (raw.startsWith('gitgrove://')) {
      try {
        const url = new URL(raw)
        const fromQuery = url.searchParams.get('path') || url.searchParams.get('repo')
        if (fromQuery) return decodeURIComponent(fromQuery)
        let pathname = decodeURIComponent(url.pathname)
        if (pathname && pathname !== '/') {
          if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
          return pathname
        }
      } catch {
        // ignore malformed deep links
      }
      continue
    }
    if (!path.isAbsolute(raw)) continue
    if (raw === app.getAppPath() || raw.endsWith('/out/main/index.js')) continue
    try {
      if (statSync(raw).isDirectory()) return raw
    } catch {
      // not an existing directory; ignore
    }
    void cwd
  }
  return null
}

app.on('second-instance', (_event, argv, workingDirectory) => {
  const target = parseLaunchTarget(argv, workingDirectory)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    if (target) mainWindow.webContents.send(IPC_MENU, `open-path:${target}`)
  } else if (target) {
    pendingDeepLink = target
  }
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  const target = parseLaunchTarget([url], process.cwd())
  if (!target) return
  if (mainWindow) {
    mainWindow.focus()
    mainWindow.webContents.send(IPC_MENU, `open-path:${target}`)
  } else {
    pendingDeepLink = target
  }
})

function registerIpc(): void {
  ipcMain.handle(IPC_INVOKE, async (event, envelope: IpcEnvelope) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return { ok: false, error: 'Unauthorized IPC sender' }
    }
    if (!envelope || typeof envelope.channel !== 'string') {
      return { ok: false, error: 'Invalid IPC request' }
    }
    try {
      const value = await router.handle(envelope.channel as IpcChannel, envelope.payload)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message.slice(0, 8000) }
    }
  })
}

app.whenReady().then(async () => {
  try {
    store = new AppStore()
    await store.init()

    const tasks = new TaskManager((taskEvent) => {
      mainWindow?.webContents.send(IPC_TASK_EVENT, { event: taskEvent })
    })
    const providers = new ProviderService(store)
    router = new Router(store, tasks, providers, () => mainWindow)

    installMenu()
    ;(app as EventEmitter).on(IPC_MENU, (action: string) => {
      mainWindow?.webContents.send(IPC_MENU, action)
    })

    registerAppProtocol(path.join(__dirname, '../renderer'))
    registerIpc()
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    const initial = pendingDeepLink ?? parseLaunchTarget(process.argv.slice(1), process.cwd())
    if (initial) {
      pendingDeepLink = null
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow?.webContents.send(IPC_MENU, `open-path:${initial}`)
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    dialog.showErrorBox('GitGrove could not start', message)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow()
  }
})
