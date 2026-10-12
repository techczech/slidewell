import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../src/main/app-menu'

// The template is pure: Electron is only type-imported, so this runs without an app.
function submenuOf(menu: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(menu.submenu) ? menu.submenu : []
}

describe('application menu template', () => {
  it('puts Settings… with ⌘, in the app menu and its click calls the callback', () => {
    const openSettings = vi.fn()
    const template = appMenuTemplate(openSettings)
    const appMenu = submenuOf(template[0])
    const settings = appMenu.find((item) => item.label === 'Settings…')
    expect(settings).toBeDefined()
    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    expect(appMenu.indexOf(settings!)).toBeGreaterThan(appMenu.findIndex((item) => item.role === 'about'))
    settings?.click?.({} as never, undefined, {} as never)
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the edit, view and window role menus and the standard app roles', () => {
    const template = appMenuTemplate(() => undefined)
    const roles = template.map((menu) => menu.role).filter(Boolean)
    expect(roles).toEqual(['editMenu', 'viewMenu', 'windowMenu'])
    const appRoles = submenuOf(template[0]).map((item) => item.role).filter(Boolean)
    expect(appRoles).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
  })
})
