// The "How sure" filter on Review's header row: a button showing the range, and a small popover with
// From and To (5% steps, 50 to 100) and a live count. The range is plain state in Review.tsx; nothing is saved.
import { useEffect, useId, useRef, useState } from 'react'
import type { ReviewSure } from '../../preload'

/** The whole range 50 to 100 is the same as no filter. */
export const isWholeRange = (r: ReviewSure): boolean => Math.round(r.min * 100) <= 50 && Math.round(r.max * 100) >= 100
export const pctOf = (x: number): number => Math.round(x * 100)
/** "50–65%" */
export const sureWords = (r: ReviewSure): string => `${pctOf(r.min)}–${pctOf(r.max)}%`

export type SureCounts = { needALook: number; needAll: number; confident: number; confidentAll: number }

export function SureFilter({ value, onChange, counts }: { value: ReviewSure | null; onChange: (r: ReviewSure | null) => void; counts: SureCounts }): JSX.Element {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const fromInput = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  const from = value ? pctOf(value.min) : 50
  const to = value ? pctOf(value.max) : 100

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  const close = (): void => {
    setOpen(false)
    btn.current?.focus()
  }
  const set = (a: number, b: number): void => onChange(a <= 50 && b >= 100 ? null : { min: a / 100, max: b / 100 })
  const filtered = value !== null
  const line = filtered
    ? `${counts.needALook} of ${counts.needAll} need a look, ${counts.confident} of ${counts.confidentAll} sorted confidently`
    : `${counts.needAll} need a look, ${counts.confidentAll} sorted confidently`

  return (
    <div
      className="rv-sure"
      ref={box}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <button ref={btn} className={`rv-sure-btn${filtered ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        How sure: {value ? sureWords(value) : 'all'}
      </button>
      {open && (
        <div className="rv-sure-pop" id={id} role="dialog" aria-label="How sure">
          <label>
            <span>From <b data-testid="sure-from">{from}%</b></span>
            <input ref={fromInput} type="range" min={50} max={100} step={5} value={from} aria-label="From" onChange={(e) => set(Math.min(Number(e.target.value), to), to)} />
          </label>
          <label>
            <span>To <b data-testid="sure-to">{to}%</b></span>
            <input type="range" min={50} max={100} step={5} value={to} aria-label="To" onChange={(e) => set(from, Math.max(Number(e.target.value), from))} />
          </label>
          <p className="rv-sure-count" data-testid="sure-count">{line}</p>
          {/* Show all disables itself once clicked, which would drop focus to the page: keep it in the popover on From, so Escape still closes it */}
          <button className="rv-link rv-sure-all" disabled={!filtered} onClick={() => { onChange(null); fromInput.current?.focus() }}>Show all</button>
        </div>
      )}
    </div>
  )
}
