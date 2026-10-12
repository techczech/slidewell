import type { MenuItemConstructorOptions } from 'electron'

// The application menu. Electron's default menu has no Settings item, so ⌘, did nothing. This keeps
// every standard macOS menu by role (copy/paste, undo, reload, devtools, zoom, minimise, close) and
// adds "Settings…" to the app menu. Pure: no Electron values are read here, so it is testable without
// a running app. The Settings click is passed in by the caller.
export function appMenuTemplate(openSettings: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: 'SlideWell',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
