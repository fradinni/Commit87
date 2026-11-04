import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { IPC_WINDOW_STATE } from '@shared/ipc'
import { APP_ENTRY } from './protocol'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b1015',
    title: 'GitGrove',
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !process.env.GITGROVE_DISABLE_DEVTOOLS
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('maximize', () => window.webContents.send(IPC_WINDOW_STATE, { maximized: true }))
  window.on('unmaximize', () => window.webContents.send(IPC_WINDOW_STATE, { maximized: false }))

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadURL(APP_ENTRY)
  }

  return window
}
