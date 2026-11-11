import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { IPC_INVOKE, IPC_MENU, IPC_TASK_EVENT, IPC_UPDATE_STATUS } from '@shared/ipc'
import type { IpcChannel, IpcEnvelope } from '@shared/ipc'
import { AppStore } from './store'
import { parseLaunchTarget } from './launch'
import { TaskManager } from './tasks'
import { validateGitExecutable } from './git/runner'
import { ProviderService } from './providers/service'
import { Router } from './ipc/router'
import { GrantStore } from './ipc/grants'
import { createMainWindow } from './window'
import { createSplashWindow } from './splash'
import { installMenu } from './menu'
import { registerAppProtocol, registerAppScheme } from './protocol'
import { UpdateService, type UpdateAdapter } from './updates'
import { createElectronUpdater, createInertUpdater } from './update-adapter'
import { createAppImageProbe, verifyAppImage } from './appimage-binding'
import { hasDeveloperIdSignature } from './mac-signing'
import { safeLog, tolerateBrokenStdio } from './logging'
import { APP_VERSION } from './version'

// Diagnostics must never be able to crash the app: a launcher or terminal can
// close the stdio pipe, and the next console write would raise EPIPE.
tolerateBrokenStdio(process.stdout)
tolerateBrokenStdio(process.stderr)

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
let launchTarget: string | null = null
/** Main-owned grants for repository roots, worktree aliases and executables. */
let grants: GrantStore | null = null
/** True once the renderer has asked for its launch target and listens for open-path events. */
let rendererBooted = false
/** Recreates the window after macOS closed it; set when the app is ready. */
let ensureMainWindow: (() => void) | null = null
let resolveRouter!: (router: Router) => void
/** Resolves as soon as config/tasks/providers are ready; IPC awaits it. */
const routerReady = new Promise<Router>((resolve) => {
  resolveRouter = resolve
})

/**
 * An OS launch argument, deep link or Finder event names a folder the user (or
 * the system acting for them) chose, so it is a main-owned grant before the
 * renderer is allowed to open it.
 */
async function grantLaunchTarget(target: string): Promise<void> {
  try {
    await grants?.grantPath(target)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    safeLog(console, '[commit87]', 'warn', `could not grant the launch target: ${detail}`)
  }
  queueOrDeliver(target)
}

function deliverLaunch(raw: string): void {
  const target = parseLaunchTarget([raw], app.getAppPath())
  if (target) void grantLaunchTarget(target)
}

/**
 * A loaded window takes the path straight away. During boot or a reload the
 * renderer has no listener yet, so it reads the queued target from
 * `app.launchTarget` instead, and the window is reopened if it was closed.
 * The queue holds one target: several folders opened before boot keep the last.
 */
function queueOrDeliver(target: string): void {
  if (mainWindow && rendererBooted) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send(IPC_MENU, `open-path:${target}`)
    return
  }
  launchTarget = target
  if (!mainWindow) ensureMainWindow?.()
}

app.on('second-instance', (_event, argv, _workingDirectory) => {
  const target = parseLaunchTarget(argv, app.getAppPath())
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  if (target) void grantLaunchTarget(target)
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  deliverLaunch(url)
})

// macOS delivers Finder "Open With", drag-onto-dock and `open -a` folders here.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  deliverLaunch(filePath)
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
  grants = new GrantStore(path.join(app.getPath('userData'), 'grants.json'))
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

  launchTarget = launchTarget ?? parseLaunchTarget(process.argv.slice(1), app.getAppPath())

  const openMainWindow = (): void => {
    if (mainWindow) return
    const window = createMainWindow()
    mainWindow = window
    window.once('ready-to-show', () => {
      traceBoot('main window ready')
      dismissSplash()
    })
    window.webContents.on('did-start-loading', () => {
      rendererBooted = false
    })
    window.webContents.on('render-process-gone', () => {
      rendererBooted = false
    })
    window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (!isMainFrame) return
      rendererBooted = false
      dismissSplash()
    })
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null
      rendererBooted = false
      // A target queued for a window that is gone must not reopen minutes later.
      launchTarget = null
    })
  }
  ensureMainWindow = openMainWindow
  openMainWindow()

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

    if (!grants) throw new Error('The authorization store could not be created')
    const grantStore = grants
    await grantStore.load()
    // Repositories the user already opened and the folder passed on this
    // launch are the grants this session starts with.
    await grantStore.seedRecent(store.getConfig().recentRepos.map((repo) => repo.path))
    if (launchTarget) await grantStore.grantPath(launchTarget)
    const configuredGit = store.getConfig().gitBinary
    if (configuredGit) {
      const granted = await grantStore.isGrantedExecutable(configuredGit)
      const check = granted ? await validateGitExecutable(configuredGit) : { ok: false }
      if (!check.ok) {
        safeLog(console, '[commit87]', 'warn', 'ignoring a Git executable that is no longer granted and executable')
        await store.setGitBinary('')
      }
    }

    const tasks = new TaskManager((taskEvent) => {
      mainWindow?.webContents.send(IPC_TASK_EVENT, { event: taskEvent })
    })
    const providers = new ProviderService(store)
    // electron-updater throws at construction when the running app version is
    // not semver, which is the case when the main bundle is launched directly.
    // Fall back to an inert adapter so the window still opens, and force the
    // environment to "unpackaged" so the UI reports updates as unavailable.
    let updaterAdapter: UpdateAdapter | null = null
    try {
      updaterAdapter = createElectronUpdater()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      safeLog(console, '[commit87:update]', 'warn', `disabled: ${detail}`)
    }
    // Squirrel.Mac validates an update against the designated requirement of the
    // running bundle. An ad-hoc signature pins that requirement to the current
    // cdhash, so only a Developer ID-signed build can install an in-place update.
    const macDeveloperId =
      process.platform === 'darwin' && app.isPackaged
        ? await hasDeveloperIdSignature(path.resolve(path.dirname(process.execPath), '../..'))
        : false
    // `APPIMAGE`/`APPDIR` are untrusted hints: bind the replacement target to
    // the kernel mount that actually contains this executable, and fail closed
    // when no such mount exists.
    const appImage = verifyAppImage(createAppImageProbe())
    const updates = new UpdateService({
      adapter: updaterAdapter ?? createInertUpdater(),
      environment: {
        platform: process.platform,
        isPackaged: updaterAdapter ? app.isPackaged : false,
        appImage: appImage.ok ? appImage.target : null,
        // Only explain AppImage verification when the environment actually
        // claimed to be one; a .deb/.rpm/tar.gz run has no hint and must keep
        // the package-manager wording.
        appImageReason: !appImage.ok && process.env.APPIMAGE ? appImage.reason : undefined,
        portable: process.env.PORTABLE_EXECUTABLE_FILE,
        snap: process.env.SNAP,
        flatpak: process.env.FLATPAK_ID,
        // NSIS installs ship an uninstaller next to the executable; portable and
        // zip builds do not, so they are not updated in place.
        windowsUninstaller: existsSync(path.join(path.dirname(process.execPath), 'Uninstall Commit87.exe')),
        macDeveloperId
      },
      version: APP_VERSION,
      preferences: () => {
        const config = store.getConfig()
        return { channel: config.updateChannel, autoCheck: config.autoUpdateCheck }
      },
      onChange: (status) => {
        mainWindow?.webContents.send(IPC_UPDATE_STATUS, status)
      }
    })
    updates.start()
    const router = new Router(store, tasks, providers, updates, grantStore, () => mainWindow, () => {
      const target = launchTarget
      launchTarget = null
      rendererBooted = true
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
  ensureMainWindow?.()
})
