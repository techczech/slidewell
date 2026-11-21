import { useCallback, useEffect, useRef, useState } from 'react'
import type { Stats } from '../../preload'
import { aliasesOf, commandForEvent, registry, SCREEN_KEYS, withChord } from '../../shared/commands'
import { PictureSearchStatusBar } from './PictureSearch'
import { ReviewScreen } from './Review'
import { TeachRoundHost } from './TeachRound'
import { TriagePanel, type TriageTab } from './TriagePanel'
import { useSorterBusy } from './sorter-hooks'
import { FRAME_COMMANDS, useSearchView, type AppView } from './SearchView'
import { ImportPanel } from './ImportPanel'
import { ConvertPanel } from './ConvertPanel'
import { StatsPanel } from './StatsPanel'
import { UpdateStatus } from './UpdateNotices'

export default function App(): JSX.Element {
  const [toast, setToastMsg] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showConvert, setShowConvert] = useState(false)
  const [showStats, setShowStats] = useState(false)
  // effective chords (defaults + his own shortcuts from Settings › Shortcuts), for keys, tooltips and the cheat sheet
  const [bindings, setBindings] = useState<Record<string, string>>(() => registry.bindingsOf({}))
  useEffect(() => {
    void window.sw.app.bindings().then((b) => { if (Object.keys(b).length) setBindings(b) })
    return window.sw.app.onSettingsChanged((b) => {
      setBindings(b)
      setRefreshKey((k) => k + 1)
    })
  }, [])
  const [showHelp, setShowHelp] = useState(false)
  // Search | Review | Triage (locked 2026-10-12); the Review tab carries how many need a look, the Triage tab a dot while the sorter runs
  const [appView, setAppView] = useState<AppView>('search')
  const [triageTab, setTriageTab] = useState<TriageTab>('undecided') // kept while he is on another tab
  const sorterBusy = useSorterBusy()
  const [reviewCount, setReviewCount] = useState(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // a scan of the talks finished: counts, pills and the inspector follow the new usage
  useEffect(() => window.sw.archive.onTalkUsageChanged((r) => { if (r.ok) setRefreshKey((k) => k + 1) }), [])
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const setToast = useCallback((msg: string) => {
    setToastMsg(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 1400)
  }, [])

  const openStats = useCallback(() => {
    setShowStats(true)
    if (!stats) void window.sw.archive.stats().then(setStats)
  }, [stats])

  const { archiveOk, archivePath, chooseArchive, inspectorOpen, navCount, activeItem, runCommand, closeMenu, content, overlays } = useSearchView({
    appView, setAppView, setTriageTab, bindings, refreshKey, setRefreshKey, setToast,
    showHelp, setShowHelp, showStats, setShowStats, showImport, setShowImport,
    showConvert, setShowConvert, openStats
  })

  // Settings (⌘,), the cheat sheet (⌘/) and export/import work on every screen, over any overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const id = commandForEvent(e, bindings, { inField: typing, onControl: false, overlay: false })
      if (!id || !FRAME_COMMANDS.has(id)) return
      e.preventDefault()
      runCommand(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindings, runCommand])
  // menu-bar commands (generated from the registry in main) run here; Settings, Export and Import run in main
  useEffect(() => window.sw.app.onCommand((id) => runCommand(id)), [runCommand])
  // the menu greys out what cannot run now
  useEffect(() => {
    void window.sw.app.setContext({ view: appView, hasItems: navCount > 0, hasActive: Boolean(activeItem) })
  }, [appView, navCount, activeItem])


  useEffect(() => {
    void window.sw.review.overview({ queue: 0, sample: 0 }).then((o) => setReviewCount(o.needALook)).catch(() => undefined)
  }, [refreshKey])

  return (
    <div className={inspectorOpen && appView === 'search' ? 'app has-sidebar' : 'app'} onClick={closeMenu}>
      <header className="titlebar">
        <span className="wordmark">
          Slide<span className="well">Well</span>
        </span>
        <div className="scope view-switch" role="tablist" aria-label="View">
          <button role="tab" aria-selected={appView === 'search'} className={appView === 'search' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('search')}>
            Search
          </button>
          <button role="tab" aria-selected={appView === 'review'} className={appView === 'review' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('review')}>
            Review {reviewCount > 0 && <span className="rv-tab-n">{reviewCount}</span>}
          </button>
          <button role="tab" aria-selected={appView === 'triage'} className={appView === 'triage' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('triage')}>
            Triage
            {sorterBusy && <span className="pulse-dot" role="img" aria-label="sorting" />}
          </button>
        </div>
        <div className="titlebar-actions">
          <button
            className="tb-btn"
            onClick={() => {
              setShowStats(true)
              if (!stats) void window.sw.archive.stats().then(setStats)
            }}
            title={withChord(bindings, 'stats', 'Your PowerPoint history in numbers')}
          >
            📊 Stats
          </button>
          <button className="tb-btn" onClick={() => setShowImport(true)} title={withChord(bindings, 'import', 'Import PowerPoint into the archive')}>
            ⤓ Import
          </button>
          <button
            className="tb-btn"
            onClick={() => setShowConvert(true)}
            title="Convert someone else's PowerPoint to an editable Outline — saved where you choose, never added to your archive or vault"
          >
            ⇄ Convert
          </button>
          <button className="tb-btn" onClick={() => runCommand('settings')} title={withChord(bindings, 'settings', 'Settings')}>
            ⚙
          </button>
          <button className="tb-btn" onClick={() => setShowHelp(true)} title={withChord(bindings, 'cheat', 'Keyboard shortcuts')}>
            ⌨
          </button>
        </div>
      </header>

      <TeachRoundHost onShowReview={() => setAppView('review')} onOpenAutoSorting={() => { setTriageTab('auto'); setAppView('triage') }} />
      {appView === 'review' && <ReviewScreen onCount={setReviewCount} onToast={setToast} onOpenAutoSorting={() => { setTriageTab('auto'); setAppView('triage') }} />}
      {appView === 'triage' && (
        <TriagePanel tab={triageTab} onTab={setTriageTab} onReview={() => setAppView('review')} onSettings={() => void window.sw.app.openSettings('capture')} onChanged={() => setRefreshKey((k) => k + 1)} onToast={setToast} />
      )}
      {content}

      <footer className="statusbar">
        {archiveOk === null ? (
          <span>checking archive…</span>
        ) : archiveOk ? (
          <span className="ok">● archive connected</span>
        ) : (
          <span className="warn">
            ● archive not found
            <button className="link" onClick={chooseArchive}>choose folder</button>
          </span>
        )}
        <PictureSearchStatusBar />
        <span className="path" title={archivePath}>{archivePath}</span>
        <UpdateStatus />
      </footer>

      {overlays}
      {showHelp && <HelpOverlay bindings={bindings} onClose={() => setShowHelp(false)} />}

      {showImport && <ImportPanel onClose={() => setShowImport(false)} onDone={() => setRefreshKey((k) => k + 1)} />}

      {showConvert && <ConvertPanel onClose={() => setShowConvert(false)} />}

      {showStats && <StatsPanel stats={stats} onClose={() => setShowStats(false)} />}


      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}


function HelpOverlay({ bindings, onClose }: { bindings: Record<string, string>; onClose: () => void }): JSX.Element {
  const groups = registry.groups
    .map((group) => ({ group, entries: registry.defs.filter((d) => d.group === group && !d.hidden) }))
    .filter((g) => g.entries.length > 0)
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Keyboard shortcuts</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <p className="settings-note">Change any shortcut in Settings › Shortcuts. Single-letter keys work when the cursor is outside the search field.</p>
        <div className="details-table help-table">
          {groups.map((g) => (
            <div key={g.group} className="help-group">
              <div className="help-group-head">{g.group}</div>
              {g.entries.map((d) => {
                const chord = bindings[d.id]
                const keys = chord ? [chord, ...aliasesOf(d.id)] : []
                return (
                  <div className="drow" key={d.id} data-command={d.id}>
                    <span className="dk help-key">{keys.length > 0 ? keys.join('  ·  ') : <span className="help-none">None</span>}</span>
                    <span className="dv">{d.label}</span>
                  </div>
                )
              })}
            </div>
          ))}
          <div className="help-group">
            <div className="help-group-head">On the Review and Triage screens</div>
            {SCREEN_KEYS.map(([screen, keys]) => (
              <div className="drow" key={screen}>
                <span className="dk help-key">{screen}</span>
                <span className="dv">{keys}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
