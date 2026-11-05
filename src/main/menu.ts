import { app, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

export function installMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push(
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: () => app.emit('commit87:menu', 'open-repo') },
        { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+O', click: () => app.emit('commit87:menu', 'clone-repo') },
        { label: 'New Repository…', click: () => app.emit('commit87:menu', 'init-repo') },
        { type: 'separator' },
        { label: 'Close Tab', click: () => app.emit('commit87:menu', 'close-tab') },
        { label: 'Close All Tabs', click: () => app.emit('commit87:menu', 'close-all-tabs') },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => app.emit('commit87:menu', 'command-palette') },
        { label: 'Git Console', accelerator: 'CmdOrCtrl+J', click: () => app.emit('commit87:menu', 'toggle-console') },
        { type: 'separator' },
        { label: 'Next Repository Tab', click: () => app.emit('commit87:menu', 'next-tab') },
        { label: 'Previous Repository Tab', click: () => app.emit('commit87:menu', 'prev-tab') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Git documentation',
          click: () => void shell.openExternal('https://git-scm.com/doc')
        },
        {
          label: 'Report an issue',
          click: () => void shell.openExternal('https://github.com/fradinni/Commit87/issues')
        }
      ]
    }
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
