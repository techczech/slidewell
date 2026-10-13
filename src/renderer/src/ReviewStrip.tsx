// The sorter strip at the top of Review (frames B1, B2; ticket 23). One line: his choices, how many need a look, and
// how far it is to the next retrain. States: counting, retraining, waiting for power (with Retrain now), automatic
// retraining off (with Retrain), too few choices. After a retrain it opens to say what moved, with "See what moved"
// and Dismiss. "How many is enough?" opens the reading as a popover. Main owns every number; this only shows them
// and sends Retrain. No window-level keys: Esc is handled on the popover itself.
import { useEffect, useRef, useState } from 'react'
import type { SorterStatus } from '../../preload'
import { SorterReading } from './SorterReading'
import { useSorterStatus } from './sorter-hooks'
import { nextRetrain, retrainSummary, stripLine } from './teach-format'
import './teach.css'

const SEEN_KEY = 'sw.review.retrainSeen' // the `at` of the retrain he last dismissed

function Popover({ onClose, onOpenAutoSorting }: { onClose: () => void; onOpenAutoSorting: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
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
        <SorterReading variant="popover">
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
  if (!st) return null

  const line = stripLine(st, needALook)
  const r = st.lastRetrain
  const open = r !== null && r.at !== seen && !st.retraining
  const close = (): void => {
    setPopover(false)
    opener.current?.focus()
  }
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
            {action}
            {enough}
          </span>
        </div>
      )}
      {popover && <Popover onClose={close} onOpenAutoSorting={() => { setPopover(false); onOpenAutoSorting() }} />}
    </>
  )
}
