// Triage › Auto sorting › the piles of one sort (locked drawing 3a): a chooser for which sort, then Kept and
// Thrown away side by side and an Unsure strip. Pile cards use the same picture path as Triage cards (the
// card's thumbUrl). Moving a card across is his decision, made through triage.decide; main re-reads the piles.
// Pile keys act only while a pile card has focus and never reach the Triage grid or window shortcuts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SortPeriod, SortRun, SortRunCard, SortRunPage, SortRunPile } from '../../preload'
import { appLabel } from './TriageAppMenu'
import { day, n, whenShort } from './sorter-format'
import './sort-piles.css'

type Periods = readonly { id: SortPeriod; label: string }[]
const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s)
const upper = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
const WHO: Record<NonNullable<SortRunCard['decidedBy']>, string> = { rules: 'Rules', history: 'Past choices', luna: 'Luna', haiku: 'Haiku' }
const PAGE = 60

/** "today 14:20", "yesterday 02:00", else "12 Oct 02:00". */
export function runWhen(iso: string): string {
  const t = whenShort(iso)
  return t.startsWith('today') || t.startsWith('yesterday') ? t : day(iso).replace(',', '')
}
const periodWords = (run: SortRun, periods: Periods): string => lower(periods.find((p) => p.id === run.period)?.label ?? '')

/** The button that names the sort being shown, and the list of earlier sorts under it. */
export function SortChooser({ runs, selectedId, periods, onSelect }: { runs: SortRun[]; selectedId: string; periods: Periods; onSelect: (id: string) => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const cur = runs.find((r) => r.id === selectedId) ?? runs[0]
  if (!cur) return null
  return (
    <span className="sp-chooser" ref={wrap}>
      <button className={open ? 'sp-chooser-btn on' : 'sp-chooser-btn'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Sort of {runWhen(cur.startedAt)} · {n(cur.counts.sorted)} <span className="tam-caret">▾</span>
      </button>
      {open && (
        <div
          className="sp-chooser-pop"
          role="dialog"
          aria-label="Sorts"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          <div className="sp-chooser-head">Sorts, newest first</div>
          {runs.map((r) => (
            <button
              key={r.id}
              className={r.id === cur.id ? 'sp-chooser-row on' : 'sp-chooser-row'}
              role="menuitemradio"
              aria-checked={r.id === cur.id}
              onClick={() => {
                onSelect(r.id)
                setOpen(false)
              }}
            >
              <span className="sp-tick" aria-hidden>
                {r.id === cur.id ? '✓' : ''}
              </span>
              <span>
                <b>{upper(runWhen(r.startedAt))}</b> · {r.trigger === 'nightly' ? 'nightly, ' : ''}
                {periodWords(r, periods)} · {n(r.counts.sorted)} sorted · {n(r.counts.kept)} kept, {n(r.counts.thrownAway)} thrown away
              </span>
            </button>
          ))}
          <div className="sp-chooser-foot">A screenshot sorted again later appears only in its latest sort.</div>
        </div>
      )}
    </span>
  )
}

type PileState = { items: SortRunCard[]; total: number; next: string | null }
const EMPTY: PileState = { items: [], total: 0, next: null }
const fromPage = (p: SortRunPage): PileState => ({ items: p.items, total: p.total, next: p.next })

function Thumb({ card }: { card: SortRunCard }): JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <div className="sp-th">
      {card.thumbUrl && !failed ? <img src={card.thumbUrl} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="thumb placeholder" aria-hidden />}
      {card.offline && <span className="sp-offline">not downloaded</span>}
      {card.lowConfidence && <span className="sp-low">low confidence</span>}
    </div>
  )
}

function Open({ card, onClose }: { card: SortRunCard; onClose: () => void }): JSX.Element {
  return (
    <div className="overlay triage-preview-overlay sp-open" onClick={onClose}>
      <div
        className="lightbox"
        role="dialog"
        aria-label={card.filename}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="lb-stage">{card.thumbUrl ? <img className="lb-img" src={card.thumbUrl} alt={card.filename} /> : <div className="lb-img placeholder">no preview</div>}</div>
        <div className="lb-bar">
          <div className="lb-title">{card.filename}</div>
          <div className="lb-meta">{[card.app, card.windowTitle, card.reason].filter(Boolean).join(' · ')}</div>
          <button className="copyref sp-open-close" autoFocus onClick={onClose}>
            close ✕
          </button>
        </div>
      </div>
    </div>
  )
}

/** What followed the latest sort, from the status the old Last run block used: unsure ones sent to a service, those it settled, those still waiting for him. */
export type SortFollowUp = { name: string; sent: number; settled: number; waiting: number | null }

export function SortPiles({ runId, reloadKey, periods, onReview, followUp }: { runId: string; reloadKey: number; periods: Periods; onReview: () => void; followUp?: SortFollowUp | null }): JSX.Element | null {
  const [run, setRun] = useState<SortRun | null>(null)
  const [piles, setPiles] = useState<Record<SortRunPile, PileState>>({ kept: EMPTY, throwaway: EMPTY, unsure: EMPTY })
  const [loaded, setLoaded] = useState(false)
  const [opened, setOpened] = useState<SortRunCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const sizes = useRef<Record<SortRunPile, number>>({ kept: PAGE, throwaway: PAGE, unsure: PAGE })
  const pendingFocus = useRef<{ pile: SortRunPile; index: number } | { hash: string } | null>(null)
  const piRef = useRef(piles)
  piRef.current = piles

  const load = useCallback(async () => {
    const mine = ++seq.current
    const r = await window.sw.sorter.runPiles(runId, sizes.current)
    if (mine !== seq.current) return // a newer read is on its way
    setRun(r.run)
    setPiles({ kept: fromPage(r.kept), throwaway: fromPage(r.throwaway), unsure: fromPage(r.unsure) })
    setLoaded(true)
  }, [runId])

  useEffect(() => {
    sizes.current = { kept: PAGE, throwaway: PAGE, unsure: PAGE }
    setLoaded(false)
    setError(null)
    void load()
  }, [load, reloadKey])

  // after a card moves, focus lands on the card now at the same place in the same pile, so the keys can carry on down a pile
  useLayoutEffect(() => {
    const p = pendingFocus.current
    if (!p || !root.current) return
    pendingFocus.current = null
    if ('hash' in p) {
      root.current.querySelector<HTMLElement>(`[data-hash="${CSS.escape(p.hash)}"]`)?.focus()
      return
    }
    const cards = root.current.querySelectorAll<HTMLElement>(`[data-pile="${p.pile}"] [data-card]`)
    cards[Math.min(p.index, cards.length - 1)]?.focus()
  }, [piles])

  const more = useCallback(
    async (pile: SortRunPile) => {
      const cur = piRef.current[pile]
      if (!cur.next) return
      const page = await window.sw.sorter.runPage(runId, pile, cur.next, PAGE)
      sizes.current[pile] += page.items.length
      setPiles((p) => ({ ...p, [pile]: { items: [...p[pile].items, ...page.items.filter((c) => !p[pile].items.some((x) => x.hash === c.hash))], total: page.total, next: page.next } }))
    },
    [runId]
  )

  const decide = useCallback(
    async (card: SortRunCard, action: 'select' | 'exclude' | 'reset') => {
      const index = piRef.current[card.pile].items.findIndex((c) => c.hash === card.hash)
      pendingFocus.current = { pile: card.pile, index }
      sizes.current = { kept: Math.max(PAGE, piRef.current.kept.items.length), throwaway: Math.max(PAGE, piRef.current.throwaway.items.length), unsure: Math.max(PAGE, piRef.current.unsure.items.length) }
      try {
        const r = await window.sw.triage.decide(card.hash, action)
        if (r.refused) setError(r.refused)
        else setError(null)
      } catch {
        setError('That choice was not saved.')
      }
      await load()
    },
    [load]
  )

  const onKey = (e: React.KeyboardEvent<HTMLElement>, card: SortRunCard): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    if (document.querySelector('.overlay, [role="dialog"]')) return // a menu or dialog is open: not ours
    let action: 'select' | 'exclude' | 'reset' | null = null
    if (e.key === 'ArrowLeft' && card.pile !== 'kept') action = 'select' // to the Kept pile on the left
    else if (e.key === 'ArrowRight' && card.pile !== 'throwaway') action = 'exclude' // to the Thrown away pile on the right
    else if ((e.key === 'u' || e.key === 'U') && card.decision !== null) action = 'reset'
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
    const isNav = e.key === 'ArrowDown' || e.key === 'ArrowUp'
    if (action) {
      e.preventDefault()
      e.stopPropagation()
      void decide(card, action)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      setOpened(card)
    } else if (isNav) {
      e.preventDefault()
      e.stopPropagation()
      const list = Array.from(e.currentTarget.closest('[data-pile]')?.querySelectorAll<HTMLElement>('[data-card]') ?? [])
      const i = list.indexOf(e.currentTarget)
      list[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    } else if (isArrow || e.key === 'u' || e.key === 'U') {
      e.stopPropagation() // a key of ours that has nothing to do here still must not reach the grid or the window
    }
  }

  if (!loaded && !run) return null
  if (loaded && !run) return <p className="as-muted sp-gone">This sort is no longer kept. Choose another from the list.</p>
  if (!run) return null
  const when = periodWords(run, periods)
  const lead = run.period === 'all' || !when ? `Sorted ${n(run.counts.sorted)}` : `Sorted ${n(run.counts.sorted)} from the ${when}`

  const card = (c: SortRunCard): JSX.Element => (
    <div
      key={c.hash}
      className={`sp-card${c.lowConfidence ? ' low' : ''}${c.decision ? ' decided' : ''}`}
      data-card
      data-hash={c.hash}
      tabIndex={0}
      aria-label={`${appLabel(c.app ?? '')}: ${c.reason}${c.decision ? (c.decision === 'excluded' ? '. You threw it away.' : '. You kept it.') : ''}`}
      onKeyDown={(e) => onKey(e, c)}
      onDoubleClick={() => setOpened(c)}
    >
      <Thumb card={c} />
      <div className="sp-cap">
        <div className="sp-l1">
          <b>{appLabel(c.app ?? '')}</b>
          <span className="sp-by">{c.decidedBy ? WHO[c.decidedBy] : ''}</span>
        </div>
        {c.decision ? <div className="sp-yours">{c.decision === 'excluded' ? 'You threw it away' : 'You kept it'}</div> : <div className="sp-reason">{c.reason}</div>}
      </div>
    </div>
  )

  const pile = (key: 'kept' | 'throwaway', title: string, count: number): JSX.Element => (
    <div className="sp-pile" data-pile={key}>
      <h3>
        {title} <span>{n(count)}</span>
      </h3>
      <div className="sp-grid">{piles[key].items.map(card)}</div>
      {piles[key].next && (
        <button className="as-link sp-more" onClick={() => void more(key)}>
          Show more ({n(piles[key].total - piles[key].items.length)} left)
        </button>
      )}
      {piles[key].total === 0 && <p className="as-muted">Nothing here.</p>}
    </div>
  )

  return (
    <div className="sp" ref={root} data-run={run.id}>
      <div className="sp-result">
        <span>
          <b>{lead}:</b> {n(run.counts.kept)} kept, {n(run.counts.thrownAway)} thrown away, {n(run.counts.unsure)} unsure.
          {followUp && followUp.sent > 0 && ` ${n(followUp.sent)} sent to ${followUp.name}, ${n(followUp.settled)} settled.`}
          {followUp && followUp.waiting !== null && ` ${n(followUp.waiting)} waiting for you.`}
        </span>
        <button className="as-link as-review-link" onClick={onReview}>
          Review what it sorted →
        </button>
      </div>
      {error && <p className="pic-error">{error}</p>}
      <div className="sp-piles">
        {pile('kept', 'Kept', run.now.kept)}
        {pile('throwaway', 'Thrown away', run.now.thrownAway)}
      </div>
      <div className="sp-unsure" data-pile="unsure">
        <h3>
          Unsure <span>{n(run.now.unsure)} · the sorter could not tell; outlined ones are the least certain</span>
        </h3>
        <div className="sp-urow">
          {piles.unsure.items.map((c) => (
            <div
              key={c.hash}
              className={`sp-ucard${c.lowConfidence ? ' low' : ''}`}
              data-card
              data-hash={c.hash}
              tabIndex={0}
              title={`${appLabel(c.app ?? '')}: ${c.reason}`}
              aria-label={`${appLabel(c.app ?? '')}: ${c.reason}`}
              onKeyDown={(e) => onKey(e, c)}
              onDoubleClick={() => setOpened(c)}
            >
              <Thumb card={{ ...c, lowConfidence: false }} />
            </div>
          ))}
          {piles.unsure.next && (
            <button className="as-link sp-more" onClick={() => void more('unsure')}>
              Show more ({n(piles.unsure.total - piles.unsure.items.length)} left)
            </button>
          )}
        </div>
      </div>
      <div className="sp-hints">
        <span>
          <kbd>←</kbd> <kbd>→</kbd> move across
        </span>
        <span>
          <kbd>U</kbd> undecided
        </span>
        <span>
          <kbd>Return</kbd> open
        </span>
        <span className="sp-hints-end">Moving one across counts as one of your choices.</span>
      </div>
      {opened && (
        <Open
          card={opened}
          onClose={() => {
            pendingFocus.current = { hash: opened.hash }
            setOpened(null)
            setPiles((p) => ({ ...p })) // re-run the focus effect
          }}
        />
      )}
    </div>
  )
}
