// The sorter strip at the top of Review (frames B1, B2; ticket 23). One line: his choices, how many need a look, and
// how far it is to the next retrain. When the sorter has no current model (changed since it last learnt, or never trained)
// the line says so and links to Auto sorting; that beats every other state. States: counting, retraining, waiting for power (with Retrain now), automatic
// retraining off (with Retrain), too few choices. After a retrain it opens to say what moved, with "See what moved"
// and Dismiss. "How many is enough?" opens the reading as a popover. Main owns every number; this only shows them
// and sends Retrain. No window-level keys: Esc is handled on the popover itself.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SorterStatus } from '../../preload'
import { SorterReading } from './SorterReading'
import { useSorterStatus } from './sorter-hooks'
import { nextRetrain, retrainSummary, stripLine, TRAIN_LINK, trainingState } from './teach-format'
import './teach.css'

const SEEN_KEY = 'sw.review.retrainSeen' // the `at` of the retrain he last dismissed

function Popover({ onClose, onOpenAutoSorting, untrained }: { onClose: () => void; onOpenAutoSorting: () => void; untrained: 'again' | 'never' | null }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  // focus goes inside on open; Esc is also heard on the document while the popover is open, so it works when something else holds focus
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
  return (
    <div className="overlay tr-pop-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="tr-popover"
        role="dialog"
        aria-label="How many choices are enough"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <button ref={closeBtn} className="tr-popover-close" onClick={onClose} aria-label="Close">Close ✕</button>
        <SorterReading variant="popover" untrained={untrained ?? undefined}>
          <button className="ts-link tr-popover-foot" onClick={onOpenAutoSorting}>Open in Auto sorting →</button>
        </SorterReading>
      </div>
    </div>
  )
}

export function ReviewStrip({ needALook, onSeeMoved, onOpenAutoSorting, onToast }: { needALook: number; onSeeMoved: (hashes: string[]) => void; onOpenAutoSorting: () => void; onToast: (m: string) => void }): JSX.Element | null {
  const st: SorterStatus | null = useSorterStatus()
  const [popover, setPopover] = useState(false)
  const [seen, setSeen] = useState<string | null>(() => localStorage.getItem(SEEN_KEY))
  const [asked, setAsked] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const close = useCallback((): void => {
    setPopover(false)
    opener.current?.focus()
  }, [])
  if (!st) return null

  const line = stripLine(st, needALook)
  const r = st.lastRetrain
  const open = r !== null && r.at !== seen && !st.retraining && line.kind !== 'untrained'
  const retrain = async (): Promise<void> => {
    setAsked(true)
    try {
      const res = await window.sw.sorter.retrainNow('manual')
      if (!res.ok && res.error && !res.cancelled) onToast(res.error)
    } finally {
      setAsked(false)
    }
  }
  const dismiss = (): void => {
    if (!r) return
    localStorage.setItem(SEEN_KEY, r.at)
    setSeen(r.at)
  }
  const enough = (
    <button ref={opener} className="ts-link ts-enough" aria-haspopup="dialog" aria-expanded={popover} onClick={() => setPopover(true)}>
      How many is enough? ▾
    </button>
  )
  const action = line.action && (
    <button className="ts-btn ts-retrain" disabled={asked || st.retraining !== null} onClick={() => void retrain()}>
      {line.action.label}
    </button>
  )

  return (
    <>
      {open && r ? (
        <div className="ts-strip ts-open" data-kind="retrained" role="status">
          <span className="ts-dot" />
          <div className="ts-body">
            <div className="ts-summary">
              <b>{retrainSummary(r).split('. ')[0]}.</b> {retrainSummary(r).split('. ').slice(1).join('. ')}
            </div>
            <div className="ts-next">
              {r.movedHashes.length > 0 && <button className="ts-link ts-moved" onClick={() => onSeeMoved(r.movedHashes)}>See what moved</button>}
              <span>{nextRetrain(st)}</span>
              {line.action && action}
              {enough}
            </div>
          </div>
          <button className="ts-dismiss" onClick={dismiss}>Dismiss ✕</button>
        </div>
      ) : (
        <div className="ts-strip" data-kind={line.kind} role="status">
          <span className="ts-dot" />
          <span className="ts-text">
            <b>{line.text.slice(0, line.text.indexOf(':') + 1)}</b>
            {line.text.slice(line.text.indexOf(':') + 1)}
          </span>
          <span className="ts-sp">
            {line.kind === 'untrained' && <button className="ts-link ts-train-link" onClick={onOpenAutoSorting}>{TRAIN_LINK}</button>}
            {action}
            {enough}
          </span>
        </div>
      )}
      {popover && <Popover untrained={trainingState(st)} onClose={close} onOpenAutoSorting={() => { setPopover(false); onOpenAutoSorting() }} />}
    </>
  )
}
