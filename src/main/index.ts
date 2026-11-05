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
import { createSplashWindow } from './splash'
import { installMenu } from './menu'
import { registerAppProtocol, registerAppScheme } from './protocol'

app.setName('Commit87')
if (process.platform === 'win32') {
  app.setAppUserModelId('fr.fradinni.Commit87')
}

const bootStartedAt = Date.now()
/** Opt-in cold-start diagnostics: COMMIT87_STARTUP_TRACE=1 commit87 … */
function traceBoot(label: string): void {
  if (!process.env.COMMIT87_STARTUP_TRACE) return
  const now = Date.now()
  console.log(`[commit87:startup] ${label} ${now} +${now - bootStartedAt}ms`)
}
traceBoot('main process loaded')

registerAppScheme()

// A single instance keeps repo state, tasks and the credential store coherent.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = null
let launchTarget: string | null = null
let resolveRouter!: (router: Router) => void
/** Resolves as soon as config/tasks/providers are ready; IPC awaits it. */
const routerReady = new Promise<Router>((resolve) => {
  resolveRouter = resolve
})

/** Accepts `commit87://open?path=…`, `commit87:///abs/path` and plain folder argv. */
function parseLaunchTarget(argv: string[], cwd: string): string | null {
  for (const raw of argv) {
    if (!raw || raw.startsWith('-')) continue
    if (raw.startsWith('commit87://')) {
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
    launchTarget = target
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
    launchTarget = target
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
      const activeRouter = await routerReady
      const value = await activeRouter.handle(envelope.channel as IpcChannel, envelope.payload)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message.slice(0, 8000) }
    }
  })
}

app.whenReady().then(() => {
  traceBoot('app ready')
  const splash = createSplashWindow()
  splash.once('ready-to-show', () => traceBoot('splash ready'))
  let splashDismissed = false
  const dismissSplash = (): void => {
    if (splashDismissed) return
    splashDismissed = true
    if (!splash.isDestroyed()) splash.destroy()
  }
  const safety = setTimeout(dismissSplash, 15_000)
  safety.unref()

  try {
    registerAppProtocol(path.join(__dirname, '../renderer'))
    registerIpc()
  } catch (error) {
    dismissSplash()
    const message = error instanceof Error ? error.stack || error.message : String(error)
    dialog.showErrorBox('Commit87 could not start', message)
    app.quit()
    return
  }

  launchTarget = pendingDeepLink ?? parseLaunchTarget(process.argv.slice(1), process.cwd())
  pendingDeepLink = null

  mainWindow = createMainWindow()
  mainWindow.once('ready-to-show', () => {
    traceBoot('main window ready')
    dismissSplash()
  })
  mainWindow.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) dismissSplash()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void initialize().catch((error) => {
    dismissSplash()
    const message = error instanceof Error ? error.stack || error.message : String(error)
    dialog.showErrorBox('Commit87 could not start', message)
    app.quit()
  })

  async function initialize(): Promise<void> {
    const store = new AppStore()
    await store.init()
    traceBoot('app store ready')

    const tasks = new TaskManager((taskEvent) => {
      mainWindow?.webContents.send(IPC_TASK_EVENT, { event: taskEvent })
    })
    const providers = new ProviderService(store)
    const router = new Router(store, tasks, providers, () => mainWindow, () => {
      const target = launchTarget
      launchTarget = null
      return target
    })

    installMenu()
    ;(app as EventEmitter).on(IPC_MENU, (action: string) => {
      mainWindow?.webContents.send(IPC_MENU, action)
    })

    resolveRouter(router)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (pendingDeepLink && !launchTarget) {
      launchTarget = pendingDeepLink
      pendingDeepLink = null
    }
    mainWindow = createMainWindow()
  }
})
