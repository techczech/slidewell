// The app's side of the shared settings: the store (userData/settings.json), the first-launch migration
// from config.json, the Settings window, the generated menu bar, export/import and the key slots.
// Behaviour lives in the @bridle packages; this file wires them to SlideWell's schema, registry and windows.
import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandsAdapter, type SettingValue, type SettingsState } from '@bridle/settings'
import { SettingsStore } from '@bridle/settings/node'
import { installSettings, type SecretSlots, type SettingsHost } from '@bridle/settings-electron/main'
import { MAIN_COMMANDS, MENUS, NO_CONTEXT, registry, type CommandContext } from '../shared/commands'
import { APP_ID, migrateLegacy, schema } from '../shared/settings-schema'
import { migrateFromConfig, stampMigration } from './settings-migration'
import { installWriteRules } from './settings-rules'

/** Custom pages of the Settings window (renderer/src/settings-pages.tsx); the window may be opened at them. */
export const CUSTOM_PAGES = ['picture-search', 'sorter-service', 'capture-sources', 'backlog-import', 'sync', 'requirements'] as const

export type SettingsApp = {
  /** Stored values (non-defaults only) plus values written but not yet saved, by schema key. */
  values(): Record<string, unknown>
  /**
   * Changes one setting as the user (who: you); the value is readable through `values()` at once, and the
   * promise says whether it reached the settings file (a failure is also logged).
   */
  set(key: string, value: SettingValue): Promise<SaveResult>
  bindings(): Record<string, string>
  runMainCommand(id: string): void
  openSettings(section?: string): void
  setContext(ctx: CommandContext): void
  slotsChanged(): void
  /**
   * Whether an IPC event comes from the Settings window's own page in its top frame (the shared package's
   * rule), for the app's own IPC guards behind the custom pages. Pass the whole event, never just its sender.
   */
  isSettingsSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean
  settingsWebContents(): Electron.WebContents | null
  dispose(): void
}

export type SaveResult = { ok: true } | { ok: false; error: string }

type Wiring = {
  openMain(): void
  sendCommand(id: string): void
  /** Settings changed from anywhere (this app, the window, the CLI, an import). */
  changed(state: SettingsState): void
  slots: SecretSlots
  log(line: string): void
}

function settingsPageUrl(): string {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && dev) return `${dev}/settings.html`
  return pathToFileURL(join(__dirname, '../renderer/settings.html')).href
}

/**
 * Migrates config.json's preferences (first launch, or again after an older version changed them), then opens
 * the store and installs the window and menu. `legacy` is true when settings.json could not be written: main
 * then keeps reading its preferences from config.json as before, and the store is read-only.
 */
export async function startSettings(wiring: Wiring): Promise<{ settings: SettingsApp; legacy: boolean }> {
  installWriteRules() // the library-folder rule, before any store opens
  const dir = app.getPath('userData')
  const version = app.getVersion()
  const migration = await migrateFromConfig(dir, version, wiring.log)
  if (migration.kind === 'failed') wiring.log(`[settings] preferences still read from config.json: ${migration.reason}`)

  let host: SettingsHost | undefined
  let ctx: CommandContext = NO_CONTEXT
  const pending = new Map<string, SettingValue>()

  const store = new SettingsStore({
    dir,
    app: APP_ID,
    schema,
    registry: commandsAdapter(registry),
    appVersion: version,
    migrate: migrateLegacy,
    log: (line: string) => wiring.log(`[settings] ${line}`),
    onChange: (state) => {
      host?.storeChanged(state)
      wiring.changed(state)
    }
  })
  await store.ready

  // Preferences still read from config.json: the store must not collect changes main would not read (a later
  // launch would find settings.json and stop reading config.json). The window shows the store read-only.
  if (migration.kind === 'failed') store.refuseWrites('SlideWell could not move your settings to the new settings file. Your settings are unchanged.')
  else if (!store.problem()) {
    try {
      stampMigration(dir, version, migration)
    } catch (e) {
      wiring.log(`[settings] migration stamp not written (${(e as NodeJS.ErrnoException)?.code ?? 'error'})`)
    }
  }

  host = installSettings({
    app,
    store,
    schema,
    registry,
    menus: MENUS,
    slots: wiring.slots,
    openMain: wiring.openMain,
    sendCommand: wiring.sendCommand,
    menuContext: () => ctx,
    extraSections: [...CUSTOM_PAGES],
    window: { preload: join(__dirname, '../preload/settings.js'), url: settingsPageUrl(), title: 'SlideWell Settings' },
    appInfo: { icon: 'gallery-vertical-end', cli: APP_ID }
  })

  const settings: SettingsApp = {
    values: () => ({ ...store.view().settings, ...Object.fromEntries(pending) }),
    set(key, value) {
      pending.set(key, value)
      return store.set(key, value).then(
        (r): SaveResult => {
          if (pending.get(key) === value) pending.delete(key)
          if (r.ok) return { ok: true }
          wiring.log(`[settings] ${key} was not saved: ${r.error}`)
          return { ok: false, error: r.error }
        },
        (e: unknown): SaveResult => {
          if (pending.get(key) === value) pending.delete(key)
          wiring.log(`[settings] ${key} was not saved: ${(e as Error)?.message ?? 'error'}`)
          return { ok: false, error: 'The setting was not saved.' }
        }
      )
    },
    bindings: () => registry.bindingsOf(store.view().keys),
    runMainCommand(id) {
      if (!MAIN_COMMANDS.has(id)) return
      if (id === 'export-settings') void host?.exportSettings()
      else if (id === 'import-settings') host?.startImport()
      else host?.openSettingsWindow()
    },
    openSettings: (section) => void host?.openSettingsWindow(section),
    setContext(next) {
      if (next.view === ctx.view && next.hasItems === ctx.hasItems && next.hasActive === ctx.hasActive) return
      ctx = next
      host?.rebuildMenu()
    },
    slotsChanged: () => host?.slotsChanged(),
    isSettingsSender(event) {
      return Boolean(host?.isSettingsWindowSender(event as unknown as Parameters<SettingsHost['isSettingsWindowSender']>[0]))
    },
    settingsWebContents() {
      const w = host?.settingsWindow() as Electron.BrowserWindow | null | undefined
      return w && !w.isDestroyed() ? w.webContents : null
    },
    dispose() {
      host?.dispose()
      void store.close()
    }
  }
  return { settings, legacy: migration.kind === 'failed' }
}
