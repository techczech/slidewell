// Triage by source app (locked drawing 1b): an "App" menu in the toolbar with ticks, and the bar above the
// grid that excludes or selects every undecided screenshot from the ticked apps. Main owns the counts and
// refuses a bulk decision when the count changed; this file shows and asks. App name '' = app not known.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TriageAppCount, TriageBulkResult } from '../../preload'
import { n, pct } from './sorter-format'
import './triage-apps.css'

const NOT_KNOWN = 'App not known'
export const appLabel = (app: string): string => (app === '' ? NOT_KNOWN : app)
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

// The ticked apps are remembered for the session: they survive switching tabs and leaving Triage, not a restart.
let sessionTicked: string[] = []
export function useTickedApps(): [string[], (next: string[]) => void] {
  const [ticked, setTicked] = useState<string[]>(sessionTicked)
  const set = useCallback((next: string[]) => {
    sessionTicked = next
    setTicked(next)
  }, [])
  return [ticked, set]
}

/** The apps of one state tab with their counts; reloads when `version` changes (a decision, a scan). */
function useAppCounts(state: string, version: number, active = true): TriageAppCount[] | null {
  const [rows, setRows] = useState<TriageAppCount[] | null>(null)
  useEffect(() => {
    if (!active) return
    let live = true
    void window.sw.triage.apps(state).then((r) => live && setRows(r))
    return () => {
      live = false
    }
  }, [state, version, active])
  return rows
}

function KeptBar({ share }: { share: number | null }): JSX.Element {
  const k = share === null ? 0 : share * 100
  return (
    <span className="tam-kept">
      <span className="tam-bar" aria-hidden>
        <i className="k" style={{ width: `${k}%` }} />
        <i className="t" style={{ width: share === null ? 0 : `${100 - k}%` }} />
      </span>
      <span className="tam-pc">{share === null ? '—' : pct(share)}</span>
    </span>
  )
}

export function TriageAppMenu({ state, ticked, onChange, version }: { state: string; ticked: string[]; onChange: (next: string[]) => void; version: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const rows = useAppCounts(state, version, open)
  const wrap = useRef<HTMLSpanElement>(null)
  const label = ticked.length ? `App: ${ticked.map(appLabel).join(', ')}` : 'App'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // known apps in the order main gave, "App not known" last; a ticked app with nothing in this tab stays listed so it can be unticked
  const list: TriageAppCount[] = [...(rows ?? [])]
  for (const t of ticked) if (!list.some((r) => same(r.app, t))) list.push({ app: t, count: 0, kept: 0, thrownAway: 0, keptShare: null })
  list.sort((a, b) => (a.app === '' ? 1 : 0) - (b.app === '' ? 1 : 0))
  const isTicked = (app: string): boolean => ticked.some((t) => same(t, app))
  const toggle = (app: string): void => onChange(isTicked(app) ? ticked.filter((t) => !same(t, app)) : [...ticked, app])
  const countHead = state === 'undecided' ? 'Undecided' : state === 'selected' ? 'Selected' : state === 'excluded' ? 'Excluded' : 'Screenshots'

  return (
    <span className="tam-wrap" ref={wrap}>
      <button className={ticked.length ? 'tam-btn on' : 'tam-btn'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label} <span className="tam-caret">▾</span>
      </button>
      {open && (
        <div
          className="tam-pop"
          role="dialog"
          aria-label="Filter by app"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          <div className="tam-row tam-head">
            <span />
            <span>App</span>
            <span className="tam-n">{countHead}</span>
            <span>Kept before</span>
          </div>
          {rows === null && <div className="tam-empty">Loading…</div>}
          {rows !== null && list.length === 0 && <div className="tam-empty">No screenshots here have an app name.</div>}
          {list.map((r) => (
            <label key={r.app || '\u0000none'} className={isTicked(r.app) ? 'tam-row tam-app on' : 'tam-row tam-app'}>
              <input type="checkbox" checked={isTicked(r.app)} onChange={() => toggle(r.app)} />
              <span className="tam-name">{appLabel(r.app)}</span>
              <span className="tam-n">{n(r.count)}</span>
              <KeptBar share={r.keptShare} />
            </label>
          ))}
          <div className="tam-foot">
            <button className="tam-clear" disabled={ticked.length === 0} onClick={() => onChange([])}>
              Clear
            </button>
            <span className="tam-muted">{ticked.length === 1 ? '1 app ticked' : `${ticked.length} apps ticked`}</span>
            <button className="pic-primary tam-done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

const EXCLUDE_AFTER = 'In Excluded, U puts one back. Your files are not touched. Each counts as a thrown-away example when the sorter next trains.'

/** Above the Undecided grid while apps are ticked: the count, what he kept before, Exclude all and Select all. */
export function TriageAppBar({ ticked, version, onDecided }: { ticked: string[]; version: number; onDecided: () => void }): JSX.Element | null {
  const rows = useAppCounts('undecided', version)
  const [ask, setAsk] = useState<'exclude' | 'select' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const key = ticked.join('\u0000')
  useEffect(() => {
    setResult(null)
    setAsk(null)
  }, [key])
  if (ticked.length === 0 || rows === null) return null

  const picked = ticked.map((t) => {
    const r = rows.find((x) => same(x.app, t))
    return { app: t, count: r?.count ?? 0, kept: r?.kept ?? 0, thrownAway: r?.thrownAway ?? 0, keptShare: r?.keptShare ?? null }
  })
  const total = picked.reduce((s, p) => s + p.count, 0)
  const from = picked.length === 1 ? appLabel(picked[0].app) : `${picked.length} apps`
  const shares = picked.map((p) => p.keptShare)
  const before = (): string => {
    if (picked.length === 1) {
      const p = picked[0]
      const what = p.app === '' ? 'screenshots with no known app' : `${p.app} screenshots`
      return p.keptShare === null ? `You have not decided any ${what} before.` : `You kept ${pct(p.keptShare)} of the ${what} you decided on before.`
    }
    const list = picked.map((p) => `${appLabel(p.app)} ${n(p.count)}`).join(', ')
    if (shares.every((s) => s === null)) return `${list}. You have not decided any of them before.`
    const first = shares.find((s) => s !== null) ?? null
    if (shares.every((s) => s !== null && first !== null && Math.round(s * 100) === Math.round(first * 100))) return `${list}. You kept ${pct(first)} of ${picked.length === 2 ? 'both' : 'each'} before.`
    return `${list}. Kept before: ${picked.map((p) => `${appLabel(p.app)} ${pct(p.keptShare)}`).join(', ')}.`
  }

  const run = async (action: 'exclude' | 'select'): Promise<void> => {
    setAsk(null)
    setBusy(true)
    let r: TriageBulkResult
    try {
      r = await window.sw.triage.decideAll(
        picked.map((p) => p.app),
        action,
        total
      )
    } catch {
      r = { ok: false, changed: 0, skipped: 0, count: total, refused: 'bad-arguments' }
    }
    setBusy(false)
    if (r.ok) {
      const left = r.skipped > 0 ? ` ${n(r.skipped)} left undecided because the same picture also appears under another app.` : ''
      const after = action === 'exclude' ? ` ${EXCLUDE_AFTER}` : ''
      setResult(`${action === 'exclude' ? 'Excluded' : 'Selected'} ${n(r.changed)} screenshot${r.changed === 1 ? '' : 's'} from ${from}.${left}${after}`)
    }
    else setResult(r.refused === 'count-changed' ? 'The count changed. Nothing was decided.' : 'Nothing was decided.')
    onDecided() // reload the grid and the counts either way
  }

  const verb = ask === 'exclude' ? 'Exclude' : 'Select'
  return (
    <div className="tam-bulk" data-testid="app-bar">
      <div className="tam-bulk-text">
        <div className="tam-bulk-title">
          {n(total)} undecided from {from}
        </div>
        <div className="tam-muted">{before()}</div>
        {result && (
          <div className="tam-result" role="status">
            {result}
          </div>
        )}
      </div>
      <div className="tam-bulk-btns">
        <button className="copyref tam-exclude" disabled={total === 0 || busy} onClick={() => setAsk('exclude')}>
          Exclude all {n(total)}
        </button>
        <button className="pic-primary tam-select" disabled={total === 0 || busy} onClick={() => setAsk('select')}>
          Select all {n(total)}
        </button>
      </div>
      {ask && (
        <div className="overlay sorter-cloud-overlay" onClick={() => setAsk(null)}>
          <div
            className="sorter-cloud-confirm tri-confirm"
            role="dialog"
            aria-label={`${verb} all`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setAsk(null)
              }
            }}
          >
            <h3>
              {verb} all {n(total)} undecided screenshot{total === 1 ? '' : 's'} from {from}?
            </h3>
            <p>
              {ask === 'exclude'
                ? `They move to Excluded. ${EXCLUDE_AFTER}`
                : 'They are marked Selected, ready to import. Each counts as one of your choices. No file is moved or deleted.'}
            </p>
            <div className="sorter-cloud-confirm-btns">
              <button className="copyref" onClick={() => setAsk(null)}>
                Not now
              </button>
              <button className="pic-primary tam-confirm-go" autoFocus onClick={() => void run(ask)}>
                {verb} {n(total)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
