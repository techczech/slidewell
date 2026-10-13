// Triage › Auto sorting › "What the sorter goes by" (locked drawing 2): his choices by app with a rule for
// each, the built-in rules in words, and how the picture looks. Every figure, suggestion chip, button label
// and built-in rule text comes from main (sorter.goesBy); this file shows them and saves a rule at once.
import { useCallback, useEffect, useState } from 'react'
import type { AppLean, SorterAppReading, SorterGoesBy as GoesBy } from '../../preload'
import { appLabel } from './TriageAppMenu'
import { n, pct } from './sorter-format'

const CHOICES: Array<{ rule: AppLean | null; text: string }> = [
  { rule: null, text: 'No rule' },
  { rule: 'throwaway', text: 'Usually throw away' },
  { rule: 'keep', text: 'Usually keep' }
]

function RuleControl({ row, onSet, disabled }: { row: SorterAppReading; onSet: (rule: AppLean | null) => void; disabled: boolean }): JSX.Element {
  // his rule when he has one; else the built-in one, shown muted; else "No rule"
  const shown: AppLean | null = row.rule ?? row.builtIn
  const muted = row.rule === null && row.builtIn !== null
  const name = `rule-${row.app || 'none'}`
  return (
    <div className="gb-rule-cell">
      <div className="seg3" role="radiogroup" aria-label={`Rule for ${appLabel(row.app)}`}>
        {CHOICES.map((c) => {
          const on = c.rule === shown
          return (
            <label key={c.text} className={on ? (muted ? 'on bi' : 'on') : ''}>
              <input type="radio" name={name} checked={on} disabled={disabled} onChange={() => onSet(c.rule)} />
              {c.text}
            </label>
          )
        })}
      </div>
      {muted && <span className="gb-bi">Built-in rule</span>}
    </div>
  )
}

export function SorterGoesBy({ reloadKey }: { reloadKey: number }): JSX.Element | null {
  const [data, setData] = useState<GoesBy | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.sw.sorter.goesBy().then((d) => live && setData(d))
    return () => {
      live = false
    }
  }, [reloadKey])

  const set = useCallback(async (app: string, rule: AppLean | null) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.sw.sorter.setAppRule(app, rule)
      setData(r.goesBy)
      if (r.ok) setSaved(true)
      else setError(r.error ?? 'The rule was not saved.')
    } catch {
      setError('The rule was not saved.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!data) return null
  return (
    <section className="gb" aria-label="What the sorter goes by">
      <h2 className="gb-title">What the sorter goes by</h2>
      <div className="gb-cols">
        <div className="as-block gb-table-block">
          <h3 className="gb-h3">Your choices by app</h3>
          {data.apps.length === 0 ? (
            <p className="as-muted">No screenshot has an app name yet.</p>
          ) : (
            <table className="gb-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="n">Kept</th>
                  <th className="n">Thrown away</th>
                  <th className="n">Still undecided</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                {data.apps.map((a) => (
                  <tr key={a.app || '\u0000none'} data-app={a.app}>
                    <td className="gb-app">{appLabel(a.app)}</td>
                    <td className="n">
                      {n(a.kept)} <span className="gb-pc">{pct(a.keptShare)}</span>
                    </td>
                    <td className="n">{n(a.thrownAway)}</td>
                    <td className="n">{n(a.undecided)}</td>
                    <td>
                      <RuleControl row={a} onSet={(rule) => void set(a.app, rule)} disabled={busy} />
                      {a.suggestion && (
                        <div className="gb-chip">
                          <span>{a.suggestion.text}</span>{' '}
                          <button className="gb-chip-btn" disabled={busy} onClick={() => void set(a.app, a.suggestion!.rule)}>
                            {a.suggestion.action}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {saved && !error && (
            <p className="gb-saved" role="status">
              Rule saved. Used from the next sort.
            </p>
          )}
          {error && <p className="pic-error">{error}</p>}
        </div>
        <div className="gb-side">
          <div className="as-block">
            <h3 className="gb-h3">Built-in rules</h3>
            <div className="gb-sub">Usually kept</div>
            <ul className="gb-rules">
              {data.builtIn.keep.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <div className="gb-sub">Usually throwaway</div>
            <ul className="gb-rules">
              {data.builtIn.throwaway.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="as-block">
            <h3 className="gb-h3">How the picture looks</h3>
            <p>The sorter also compares each picture with the ones you kept and the ones you threw away. It cannot say which part of a picture decided it, so each sorted screenshot carries a one-line reason instead.</p>
          </div>
          <p className="as-muted">A rule leans the sorter; a demo screenshot that looks like ones you kept can still be kept.</p>
        </div>
      </div>
    </section>
  )
}
