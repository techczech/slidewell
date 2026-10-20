// Entry of the Settings window: the shared @bridle/settings-react window over SlideWell's schema and command
// registry, plus the app's own pages. State and every action come from main through the preload bridge.
import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow, type RowHint, type SheetState } from '@bridle/settings-react'
import type { SectionRequest, SettingsView } from '@bridle/settings-electron'
import '@bridle/settings-react/settings.css'
import './styles.css'
import './settings-page.css'
import { MENUS, registry } from '../../shared/commands'
import { schema } from '../../shared/settings-schema'
import { customPages } from './settings-pages'

const bridge = window.bridleSettings

const ROW_HINTS: Record<string, RowHint> = {
  'library.archiveRoot': { summary: 'Your presentations (Core A archive)' },
  'library.othersRoot': { summary: 'Other people’s presentations, kept apart' },
  'library.wellRoot': { summary: 'Images you add to SlideWell' },
  'library.vaultRoot': { summary: 'Empty: the vault TalkWeaver uses' },
  'library.conversionsRoot': { summary: 'Default place for converted Outlines' },
  'library.ownerNames': { summary: 'Comma-separated; empty: your Mac account names', example: 'Jane Smith, jsmith' },
  'sorting.period': { example: '30d' },
  'storage.archiveBackend': { control: 'segmented', example: 'r2' },
  'storage.othersBackend': { control: 'segmented', example: 'r2' },
  'storage.wellBackend': { control: 'segmented', example: 'r2' }
}

type Opened = { section: string; sheet?: SheetState; n: number }

function SettingsApp(): React.JSX.Element | null {
  const [view, setView] = useState<SettingsView | null>(null)
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 })
  const [seenAt, setSeenAt] = useState(() => Date.now())
  const openSection = useCallback((section: string) => setOpened((o) => ({ section, n: o.n + 1 })), [])

  useEffect(() => {
    const open = async (req: SectionRequest): Promise<void> => {
      let sheet: SheetState | undefined
      if (req.action === 'import') {
        const picked = await bridge.importPick()
        if (picked) sheet = { kind: picked.preview.refused ? 'refused' : 'import', fileName: picked.fileName, preview: picked.preview }
      }
      setOpened((o) => ({ section: req.section, ...(sheet ? { sheet } : {}), n: o.n + 1 }))
    }
    void bridge.view().then((v) => {
      setView(v)
      if (v.request) void open(v.request)
    })
    const offChanged = bridge.onChanged(setView)
    const offSection = bridge.onSection((r) => void open(r))
    return () => {
      offChanged()
      offSection()
    }
  }, [])

  if (!view) return null
  return (
    <>
      <div className="sw-titlebar">Settings</div>
      <SettingsWindow
        key={opened.n}
        className="sw-settings"
        schema={schema}
        state={view.state}
        registry={registry}
        menus={MENUS}
        appInfo={view.appInfo}
        actions={bridge}
        slots={view.slots}
        rowHints={ROW_HINTS}
        customPages={customPages(openSection)}
        changesSeenAt={seenAt}
        onChangesSeen={setSeenAt}
        initial={{ section: opened.section, ...(opened.sheet ? { sheet: opened.sheet } : {}) }}
      />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
