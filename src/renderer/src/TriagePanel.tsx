import { useCallback, useEffect, useRef, useState } from 'react'
import { nextPreviewIndex } from '../../main/triage-logic'
import { IDLE, adoptStatus, applySnapshot, failureMessage, importButtonLabel, importLine, isWorking, startClick, type ImportState } from '../../main/triage-import-progress'
import type { TriageItem, TriageCounts } from '../../preload'
import { AutoSortingTab } from './AutoSortingTab'
import { TriageAppBar, TriageAppMenu, useTickedApps } from './TriageAppMenu'
import { useSorterBusy } from './sorter-hooks'

// Partition triage items into [date, items] groups, preserving the (date-sorted) order.
function groupByDateList(items: TriageItem[]): Array<[string, TriageItem[]]> {
  const groups: Array<[string, TriageItem[]]> = []
  const map = new Map<string, TriageItem[]>()
  for (const it of items) {
    const d = it.date || ''
    let arr = map.get(d)
    if (!arr) {
      arr = []
      map.set(d, arr)
      groups.push([d, arr])
    }
    arr.push(it)
  }
  return groups
}

// ADR-0029: triage a source folder of screenshots/videos. Reads but never owns the folder; include
// promotes a file into the well, exclude remembers its hash. The App's global keyboard layer yields
// to this panel (it bails while the Triage tab is showing), so we run our own. Triage is a main tab;
// its fifth tab, Auto sorting, is not a grid: the grid controls and grid keys are off there.
export type TriageTab = 'undecided' | 'selected' | 'excluded' | 'all' | 'auto'
export function TriagePanel({ tab, onTab, onReview, onSettings, onChanged, onToast }: { tab: TriageTab; onTab: (t: TriageTab) => void; onReview: () => void; onSettings: () => void; onChanged: () => void; onToast: (m: string) => void }): JSX.Element {
  const sorterBusy = useSorterBusy()
  const [root, setRoot] = useState<string | null | undefined>(undefined) // undefined = loading, null = unset
  const [items, setItems] = useState<TriageItem[]>([])
  const [counts, setCounts] = useState<TriageCounts>({ undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 })
  const [cols, setCols] = useState<number>(() => {
    const n = Number(localStorage.getItem('sw.triage.cols'))
    return n >= 2 && n <= 6 ? n : 6
  })
  useEffect(() => { localStorage.setItem('sw.triage.cols', String(cols)) }, [cols])
  // fewer columns → taller tiles, so the preview genuinely grows
  const THUMB_H: Record<number, number> = { 2: 320, 3: 260, 4: 210, 5: 175, 6: 150 }
  const gridVars = { ['--triage-cols']: cols, ['--triage-thumb-h']: `${THUMB_H[cols] ?? 150}px` } as React.CSSProperties
  const [q, setQ] = useState('')
  const [debq, setDebq] = useState('')
  const stateFilter = tab === 'auto' ? 'undecided' : tab // the grid behind the counts; Auto sorting lists nothing
  const [sort, setSort] = useState<'scanned' | 'date-desc' | 'date-asc'>('scanned')
  const [apps, setApps] = useTickedApps() // the source apps ticked in the App menu (kept for the session)
  const appsKey = apps.join('\u0000')
  const [groupByDate, setGroupByDate] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState('')
  // The import run (started here, or already going when the panel opened); its result line stays until dismissed or the next run.
  const [imp, setImp] = useState<ImportState>(IDLE)
  const impRef = useRef<ImportState>(IDLE)
  const setImpState = (next: ImportState): void => {
    impRef.current = next
    setImp(next)
  }
  const [sel, setSel] = useState(0)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [preview, setPreview] = useState<TriageItem | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const PAGE = 150

  useEffect(() => {
    const t = setTimeout(() => setDebq(q), 250)
    return () => clearTimeout(t)
  }, [q])

  // grouping needs the list date-ordered so each day's items are contiguous
  const listSort = groupByDate && !sort.startsWith('date') ? 'date-desc' : sort
  const refresh = useCallback(async () => {
    try {
      const r = await window.sw.triage.list(debq, stateFilter, listSort, PAGE, page * PAGE, apps.length ? apps : undefined)
      setItems(r.items)
      setCounts(r.counts)
      setHasMore(r.hasMore)
      setSel((s) => Math.min(s, Math.max(0, r.items.length - 1)))
    } catch {
      /* a mid-scan read may briefly lose to a write; the next tick retries */
    }
  }, [debq, stateFilter, listSort, page, appsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // a filter/search/sort change resets to the first page
  useEffect(() => setPage(0), [debq, stateFilter, listSort, appsKey])
  // jump to the top of the grid when the page changes
  useEffect(() => {
    document.querySelector('.triage-scroll')?.scrollTo(0, 0)
  }, [page])

  // Lazy load: as the scan streams progress, re-list (throttled) so rows appear as they land —
  // the user sees continuous movement instead of a blank "scanning…".
  const refreshRef = useRef(refresh)
  const lastTickRef = useRef(0)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => setRoot(p.screenshotRoot ?? p.captureSources.find((c) => c.exists)?.path ?? null))
    const offChanged = window.sw.triage.onChanged(() => void refreshRef.current())
    const offProgress = window.sw.triage.onProgress((line) => {
      setProgress(line)
      const now = Date.now()
      if (now - lastTickRef.current > 600) {
        lastTickRef.current = now
        void refreshRef.current()
      }
    })
    const offImport = window.sw.triage.onImportProgress((snap) => {
      setImpState(applySnapshot(impRef.current, snap))
      const now = Date.now()
      if (snap.phase !== 'working' || now - lastTickRef.current > 600) {
        lastTickRef.current = now
        void refreshRef.current()
      }
    })
    void window.sw.triage.importStatus().then((st) => {
      if (!isWorking(impRef.current)) setImpState(adoptStatus(st))
    })
    return () => {
      offChanged()
      offProgress()
      offImport()
    }
  }, [])

  useEffect(() => {
    if (root) void refresh()
  }, [root, refresh])

  const scan = useCallback(async () => {
    setScanning(true)
    setProgress('scanning…')
    const r = await window.sw.triage.scan()
    setScanning(false)
    setProgress(r.ok ? `${r.indexed} new · ${r.total} media files` : 'scan failed')
    await refresh()
  }, [refresh])

  const chooseFolder = useCallback(async () => {
    const p = await window.sw.settings.chooseScreenshotFolder()
    if (!p) return
    setRoot(p)
    setScanning(true)
    setProgress('scanning…')
    const r = await window.sw.triage.scan()
    setScanning(false)
    setProgress(`${r.indexed} new · ${r.total} media files`)
    await refresh()
  }, [refresh])

  const decide = useCallback(
    async (item: TriageItem, action: 'select' | 'exclude' | 'reset') => {
      const r = await window.sw.triage.decide(item.hash, action)
      if (r.refused) {
        onToast(r.refused)
        await refresh()
        return
      }
      const newState = (r.state as TriageItem['state']) || 'undecided'
      setItems((prev) => prev.map((it) => (it.hash === item.hash ? { ...it, state: newState } : it)))
      // Counts come from the main process: it counts DISTINCT hashes per bucket, so two files with
      // identical content are one selection. Adjusting ±1 per path here overcounted that case.
      await refresh()
      onToast(action === 'select' ? 'Selected' : action === 'exclude' ? 'Excluded' : 'Unselected')
      onChanged()
    },
    [onChanged, onToast, refresh]
  )

  // Lightbox decision: record it, then show the next card (unselect stays; last card stays). The
  // preview stays open; the grid selection follows so closing lands on the card last viewed.
  const decideInPreview = useCallback(
    (action: 'select' | 'exclude' | 'reset') => {
      if (!preview) return
      void decide(preview, action)
      const idx = items.findIndex((it) => it.relPath === preview.relPath)
      const n = nextPreviewIndex(idx, items.length, action)
      if (n >= 0) {
        setPreview(items[n])
        setSel(n)
      }
    },
    [preview, items, decide]
  )

  const importSelected = useCallback(async () => {
    const click = startClick(impRef.current)
    if (!click.start) return // a run is already going; its progress is on screen
    setImpState(click.state) // working from the click, before main answers
    // staged large videos need an explicit confirm each (rare); only those currently in view can be
    // confirmed — others are reported as "over gate" and stay staged until imported from the Selected tab
    const forceHashes: string[] = []
    for (const v of items.filter((it) => it.state === 'selected' && it.kind === 'video' && it.large)) {
      if (window.confirm(`"${v.filename}" is ${v.sizeMB} MB — over the 20 MB video gate. Import it anyway?`)) forceHashes.push(v.hash)
    }
    try {
      const r = await window.sw.triage.importSelected(forceHashes)
      setImpState(r.error ? { phase: 'failed', message: r.error } : { phase: 'done', imported: r.imported, skipped: r.skipped, gated: r.gated })
    } catch (err) {
      setImpState({ phase: 'failed', message: failureMessage(err) })
    }
    await refresh()
    onChanged()
  }, [items, refresh, onChanged])

  const paste = useCallback(async () => {
    const r = await window.sw.triage.paste()
    onToast(r ? 'Pasted → added to the well' : 'No image on the clipboard')
    if (r) onChanged()
  }, [onChanged, onToast])

  useEffect(() => {
    document.querySelector('.triage-card.selected')?.scrollIntoView({ block: 'nearest' })
  }, [sel, items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      if (tab === 'auto') return // no grid here: the tab has its own controls
      if (el?.closest('.tam-pop, .tri-confirm, .tr-round')) return // the App menu and its confirm box own the keyboard while open
      if (e.key === 'Escape') {
        if (preview) setPreview(null)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void paste()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        // ⌘Y — see the full image/video
        const cur = preview ?? items[sel]
        if (cur) {
          e.preventDefault()
          setPreview(cur)
        }
        return
      }
      if (preview) {
        if (e.key === ' ' || e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') {
          e.preventDefault(); decideInPreview('select')
        } else if (e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E') {
          e.preventDefault(); decideInPreview('exclude')
        } else if (e.key === 'u' || e.key === 'U') {
          e.preventDefault(); decideInPreview('reset')
        }
        return
      }
      if (typing) return
      const cur = items[sel]
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, items.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min((s < 0 ? 0 : s) + cols, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max((s < 0 ? 0 : s) - cols, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault(); setPreview(cur)
      } else if (e.key === ' ' && cur) {
        // Space toggles: select if not selected (then advance), else unselect (stay)
        e.preventDefault()
        if (cur.state === 'selected') {
          void decide(cur, 'reset')
        } else {
          void decide(cur, 'select')
          setSel((s) => Math.min(s + 1, items.length - 1))
        }
      } else if ((e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') && cur) {
        e.preventDefault(); void decide(cur, 'select'); setSel((s) => Math.min(s + 1, items.length - 1)) // select → advance
      } else if ((e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E') && cur) {
        e.preventDefault(); void decide(cur, 'exclude'); setSel((s) => Math.min(s + 1, items.length - 1)) // X = exclude → advance
      } else if ((e.key === 'u' || e.key === 'U') && cur) {
        e.preventDefault(); void decide(cur, 'reset') // U = unselect → undecided, stay
      } else if (e.key === '[') {
        e.preventDefault()
        setPage((p) => Math.max(0, p - 1))
        setSel(0)
      } else if (e.key === ']' && hasMore) {
        e.preventDefault()
        setPage((p) => p + 1)
        setSel(0)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, sel, preview, hasMore, decide, decideInPreview, paste, cols, importSelected, tab])

  return (
    <>
        <div className="triage-panel">
          <div className="triage-head">
            <b>⛏ Triage</b>
            {typeof root === 'string' && (
              <span className="triage-root" title={root}>
                {root}
              </span>
            )}
            <div className="triage-head-actions">
              {imp.phase !== 'idle' && (
                <span className={imp.phase === 'failed' ? 'triage-import-line failed' : 'triage-import-line'} role="status" data-testid="triage-import-line">
                  {importLine(imp)}
                  {!isWorking(imp) && (
                    <button className="copyref" onClick={() => setImpState(IDLE)} aria-label="Dismiss">
                      ✕
                    </button>
                  )}
                </span>
              )}
              <button className="primary-btn" onClick={() => void importSelected()} disabled={counts.selected === 0 || isWorking(imp)} title="Import all selected screenshots into the well">
                {importButtonLabel(imp, counts.selected)}
              </button>
              <button className="tb-btn" onClick={() => void paste()} title="Paste an image from the clipboard (⌘V)">
                ⎘ Paste
              </button>
              <button className="tb-btn" onClick={() => void scan()} disabled={scanning || !root} title="Re-scan the source for new files">
                {scanning ? '… scanning' : '⟳ Rescan'}
              </button>
              <button className="tb-btn" onClick={() => void chooseFolder()}>
                {root ? '⌖ Change folder' : '⌖ Choose folder'}
              </button>
            </div>
          </div>

          <div className="triage-controls">
            <div className="scope" role="tablist" aria-label="Triage state">
              {(['undecided', 'selected', 'excluded', 'all'] as const).map((s) => (
                <button key={s} role="tab" aria-selected={tab === s} className={tab === s ? 'scope-tab active' : 'scope-tab'} onClick={() => onTab(s)}>
                  {s[0].toUpperCase() + s.slice(1)}
                  {s !== 'all' ? ` ${counts[s]}` : ''}
                </button>
              ))}
              <span className="scope-sep" />
              <button role="tab" aria-selected={tab === 'auto'} className={tab === 'auto' ? 'scope-tab new active' : 'scope-tab new'} onClick={() => onTab('auto')}>
                Auto sorting
                {sorterBusy && <span className="pulse-dot" role="img" aria-label="sorting" />}
              </button>
            </div>
            {tab === 'auto' ? (
              <span className="triage-auto-note">Search, grid size and date grouping apply to the first four tabs only.</span>
            ) : typeof root === 'string' ? (
              <>
                <input
                  ref={searchRef}
                  className="search-input"
                  placeholder="Search text…  / focus · S select · X exclude"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <TriageAppMenu state={stateFilter} ticked={apps} onChange={setApps} version={counts.undecided + counts.selected + counts.excluded} />
                <select className="triage-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                  <option value="scanned">Recently scanned</option>
                  <option value="date-desc">Date — newest</option>
                  <option value="date-asc">Date — oldest</option>
                </select>
                <div className="triage-cols" role="group" aria-label="Grid size">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} className={cols === n ? 'active' : ''} onClick={() => setCols(n)} title={`${n} columns`}>{n}</button>
                  ))}
                </div>
                <label className="toggle" title="Group by capture date">
                  <input type="checkbox" checked={groupByDate} onChange={(e) => setGroupByDate(e.target.checked)} /> Group by date
                </label>
              </>
            ) : null}
            {progress && <span className="triage-progress">{progress}</span>}
          </div>

          {tab === 'auto' ? (
            <AutoSortingTab onReview={onReview} onSettings={() => void window.sw.app.openSettings('sorter-service')} triageUndecided={counts.undecided} />
          ) : root === undefined ? (
            <div className="triage-empty">loading…</div>
          ) : root === null ? (
            <div className="triage-empty">
              <p>Pick a screenshots folder to triage. SlideWell reads it but never moves, renames, or changes your files — only the ones you include are copied into the well.</p>
              <button className="primary-btn" onClick={() => void chooseFolder()}>
                ⌖ Choose folder
              </button>
            </div>
          ) : (
            <>
              {stateFilter === 'undecided' && <TriageAppBar ticked={apps} version={counts.undecided} onDecided={() => { void refresh(); onChanged() }} />}
              {items.length === 0 ? (
                <div className="triage-empty">
                  <p>{scanning ? 'Scanning…' : counts.total === 0 ? 'Nothing scanned yet.' : `No ${stateFilter} items.`}</p>
                  {counts.total === 0 && !scanning && (
                    <button className="primary-btn" onClick={() => void scan()}>
                      ⟳ Scan this folder
                    </button>
                  )}
                </div>
              ) : groupByDate ? (
                <div className="triage-scroll" style={gridVars}>
                  {groupByDateList(items).map(([date, group]) => (
                    <div className="triage-group" key={date || 'unknown'}>
                      <div className="triage-group-head">
                        {date || 'unknown date'} · {group.length}
                      </div>
                      <div className="triage-grid">
                        {group.map((it) => {
                          const i = items.indexOf(it)
                          return <TriageCard key={it.relPath} item={it} selected={i === sel} onSelect={() => setSel(i)} onOpen={() => setPreview(it)} onDecide={(a) => void decide(it, a)} />
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="triage-grid triage-scroll" style={gridVars}>
                  {items.map((it, i) => (
                    <TriageCard key={it.relPath} item={it} selected={i === sel} onSelect={() => setSel(i)} onOpen={() => setPreview(it)} onDecide={(a) => void decide(it, a)} />
                  ))}
                </div>
              )}

              {(page > 0 || hasMore) && (
                <div className="triage-foot">
                  <button disabled={page === 0} onClick={() => { setPage((p) => Math.max(0, p - 1)); setSel(0) }}>‹ Prev  [</button>
                  <span>
                    {items.length > 0 ? `${page * PAGE + 1}–${page * PAGE + items.length}` : '0'}
                    {!debq ? ` of ${stateFilter === 'all' ? counts.total : counts[stateFilter]}` : ''}
                  </span>
                  <button disabled={!hasMore} onClick={() => { setPage((p) => p + 1); setSel(0) }}>]  Next ›</button>
                </div>
              )}
            </>
          )}
        </div>
      {preview && (
        <TriagePreview
          item={items.find((it) => it.relPath === preview.relPath) ?? preview}
          onClose={() => setPreview(null)}
          onDecide={decideInPreview}
        />
      )}
    </>
  )
}

function TriageCard({
  item,
  selected,
  onSelect,
  onOpen,
  onDecide
}: {
  item: TriageItem
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onDecide: (a: 'select' | 'exclude' | 'reset') => void
}): JSX.Element {
  const badge = item.state === 'included' ? '✓' : item.state === 'selected' ? '✓' : item.state === 'excluded' ? '✗' : ''
  // review pile (ticket 08): a throwaway stays findable here, labelled, until it reaches the Bin
  const throwaway = item.pile === 'throwaway' ? `throwaway · bin in ${item.binInDays === 1 ? '1 day' : `${item.binInDays ?? 30} days`}` : ''
  return (
    <div className={`triage-card state-${item.state}${selected ? ' selected' : ''}${item.offline ? ' offline' : ''}`} onClick={onSelect} onDoubleClick={onOpen}>
      <div className="triage-thumb" onClick={(e) => { e.stopPropagation(); onOpen() }} title={item.offline ? 'Not downloaded from OneDrive yet' : 'Open preview'}>
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : item.offline ? (
          <div className="triage-cloud" aria-hidden>☁︎<span>not downloaded</span></div>
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {item.kind === 'video' && !item.offline && <span className="triage-play">▶</span>}
        {item.kind === 'video' && <span className={item.large ? 'triage-size large' : 'triage-size'}>{item.sizeMB} MB{item.large ? ' ⚠' : ''}</span>}
        {badge && <span className={`triage-badge ${item.state}`}>{badge}</span>}
        {throwaway && <span className="triage-throwaway">{throwaway}</span>}
      </div>
      <div className="triage-meta">
        <div className="triage-name" title={item.filename}>{item.filename}</div>
        {(item.app || item.windowTitle || item.takenAt) && (
          <div className="triage-from" title={[item.takenAt?.replace('T', ' ').slice(0, 16), item.app, item.windowTitle].filter(Boolean).join(' · ')}>
            {item.takenAt && <span className="triage-when">{item.takenAt.slice(0, 10)} {item.takenAt.slice(11, 16)}</span>}
            {item.app && <span className="triage-app">{item.app}</span>}
            {item.windowTitle && <span className="triage-win">{item.windowTitle}</span>}
          </div>
        )}
        {item.snippet && <div className="triage-snip">{item.snippet}</div>}
      </div>
      <div className="triage-actions">
        {item.state !== 'selected' && item.state !== 'included' && (
          <button className="ti-inc" disabled={item.offline} title={item.offline ? 'Download it in OneDrive first' : 'Select (S / Space)'} onClick={(e) => { e.stopPropagation(); onDecide('select') }}>Select</button>
        )}
        {item.state !== 'excluded' && (
          <button className="ti-exc" title="Exclude (X)" onClick={(e) => { e.stopPropagation(); onDecide('exclude') }}>Exclude</button>
        )}
        {item.state !== 'undecided' && item.state !== 'included' && (
          <button className="ti-rst" title="Unselect (U)" onClick={(e) => { e.stopPropagation(); onDecide('reset') }}>Unselect</button>
        )}
      </div>
    </div>
  )
}

function TriagePreview({ item, onClose, onDecide }: { item: TriageItem; onClose: () => void; onDecide: (a: 'select' | 'exclude' | 'reset') => void }): JSX.Element {
  return (
    <div className="overlay triage-preview-overlay" onClick={onClose}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lb-stage">
          {item.kind === 'video' && item.mediaUrl ? (
            <video className="lb-img" src={item.mediaUrl} controls autoPlay />
          ) : item.thumbUrl ? (
            <img className="lb-img" src={item.thumbUrl} alt={item.filename} />
          ) : (
            <div className="lb-img placeholder">no preview</div>
          )}
        </div>
        <div className="lb-bar">
          <div className="lb-title">{item.filename}</div>
          <div className="lb-meta">{[item.kind, item.kind === 'video' ? `${item.sizeMB} MB` : '', `state: ${item.state}`].filter(Boolean).join(' · ')}</div>
          <button className="ti-inc" onClick={() => onDecide('select')}>Select (Space)</button>
          <button className="ti-exc" onClick={() => onDecide('exclude')}>Exclude (X)</button>
          {item.state !== 'undecided' && item.state !== 'included' && <button className="copyref" onClick={() => onDecide('reset')}>Unselect (U)</button>}
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
      </div>
    </div>
  )
}
