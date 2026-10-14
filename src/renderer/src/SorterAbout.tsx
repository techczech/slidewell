// "About the sorter": a round "i" button and the panel it opens (what it looks at, where it learns from, how training
// works, the rules by app and window, where it is stored, what leaves the Mac). Two homes: Review's strip, beside
// "How many is enough?", and the Training header in Triage › Auto sorting. The words come from sorter-about-copy.ts;
// the live numbers from the sorter status (no other call). The panel closes on Esc, on its close button and on a click
// outside, and the focus goes back to the button. Read-only.
import { useCallback, useEffect, useRef, useState } from 'react'
import { SORTER_ABOUT } from './sorter-about-copy'
import { useSorterStatus } from './sorter-hooks'
import { aboutValues } from './teach-format'
import './teach.css'

function AboutPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const st = useSorterStatus()
  const closeBtn = useRef<HTMLButtonElement>(null)
  // focus goes inside on open; Esc is heard on the document while the panel is open, wherever the focus is
  useEffect(() => {
    closeBtn.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const values = aboutValues(st)
  return (
    <div className="overlay tr-pop-overlay sa-overlay" onClick={onClose}>
      <div className="tr-popover sa-panel" role="dialog" aria-label={SORTER_ABOUT.title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <button ref={closeBtn} className="tr-popover-close" onClick={onClose} aria-label="Close">{SORTER_ABOUT.close}</button>
        <h2 className="sa-title">{SORTER_ABOUT.title}</h2>
        {SORTER_ABOUT.intro && <p className="sa-intro">{SORTER_ABOUT.intro}</p>}
        {SORTER_ABOUT.sections.map((s) => (
          <section key={s.id} className="sa-section" data-section={s.id}>
            <h3>{s.heading}</h3>
            {s.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            {'live' in s && s.live && (
              <dl className="sa-live">
                {s.live.map((row) => (
                  <div key={row.slot} className="sa-live-row" data-slot={row.slot}>
                    <dt>{row.label}</dt>
                    <dd>{values[row.slot]}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

/** The round "i" button and its panel. */
export function AboutSorterButton({ className = '' }: { className?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = useCallback((): void => {
    setOpen(false)
    btn.current?.focus()
  }, [])
  return (
    <>
      <button ref={btn} type="button" className={`sa-info ${className}`} aria-label={SORTER_ABOUT.title} title={SORTER_ABOUT.title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        i
      </button>
      {open && <AboutPanel onClose={close} />}
    </>
  )
}
