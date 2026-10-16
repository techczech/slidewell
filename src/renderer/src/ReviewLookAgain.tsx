// "Look again": every answer he gave in Review since the teaching build that still stands, with the real picture now
// (until alpha.14 some cards showed a placeholder instead). Main reads them (review.answersSince); this shows them as a grid
// like the piles grid, and K / T flip a tile through the ordinary review.act. A tile he does not touch writes nothing.
// "Done — retrain" asks main for one training after every answer written so far when anything changed (review.retrainAfterAnswers:
// never joined to a training already running, kept owed while the sorter is busy, whatever the auto-retrain switch says), and
// marks the check finished only once that ask was accepted (the banner is then gone for good). While a flip is being written,
// Done and the keys wait; while the retrain runs, the keys are off.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewAnsweredCard, ReviewAnswersSince, ReviewRetrainAsked } from '../../preload'
import { afterUndo, noteAct, session } from './review-history'
import { Shot, shownPicture } from './ReviewShot'
import { useSorterStatus } from './sorter-hooks'

/** Answers since the teaching build (local time), the window he asked about. */
export const LOOK_SINCE = '2026-10-13T00:00:00'
const SINCE_WORDS = '13 October'
const DONE_KEY = 'sw.review.lookAgainDone' // this profile's own storage: no generic settings path exists in the renderer
const PAGE = 60
const COLS = 4
export const BUSY_WORDS = 'The sorter is busy; it will retrain with your changes as soon as it is free.'
const ASK_FAILED = 'The sorter could not be asked to retrain just now. Press Done again to try once more.'

// "Not now" lasts for the session (until the window closes). Never saved.
let notNow = false
// Completed changes made here this session: a flip adds one, an undo of a flip takes one away. Kept here, not in the view,
// so leaving by Back or a tab and coming back still counts them. Done reads it; it is reset to 0 only once main accepts the ask.
let lookChanges = 0

export const lookAgainFinished = (): boolean => {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return false
  }
}
const markFinished = (): void => {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    // storage unavailable: the banner may come back next session
  }
}

export const lookAgainBannerText = (n: number): string =>
  `You answered ${n} ${n === 1 ? 'screenshot' : 'screenshots'} in Review since ${SINCE_WORDS}, when some showed a placeholder instead of the picture. Look again at ${n === 1 ? 'it' : 'them'}?`

/** The quiet banner under the sorter strip. `refreshKey` changes whenever Review reads again. */
export function ReviewLookBanner({ refreshKey, onOpen }: { refreshKey: unknown; onOpen: () => void }): JSX.Element | null {
  const [n, setN] = useState(0)
  const [hidden, setHidden] = useState(notNow)
  useEffect(() => {
    if (lookAgainFinished()) return
    let live = true
    void window.sw.review.answersSince(LOOK_SINCE, null, 1).then((r) => live && setN(r.total)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [refreshKey])
  if (hidden || n === 0 || lookAgainFinished()) return null
  return (
    <div className="rv-blind" role="status" data-testid="look-banner">
      <span className="rv-blind-text">{lookAgainBannerText(n)}</span>
      <span className="rv-blind-acts">
        <button className="ts-btn" data-testid="look-open" onClick={onOpen}>Look again</button>
        <button className="ts-link" data-testid="look-later" onClick={() => { notNow = true; setHidden(true) }}>Not now</button>
      </span>
    </div>
  )
}

type Filter = 'all' | 'keep' | 'throwaway'
/** A flip made here, for ⌘Z: main's undo id for it (review.act's undoId), so an undo is matched to exactly this act. */
type Undo = { undoId: number; hash: string; prev: 'keep' | 'throwaway' }

const takenLine = (c: ReviewAnsweredCard): string => [c.app, c.windowTitle].filter(Boolean).join(' · ') || 'No app or window recorded'

export function ReviewLookAgain({ onBack, onFinished, onToast }: { onBack: () => void; onFinished: () => void; onToast: (m: string) => void }): JSX.Element {
  const [items, setItems] = useState<ReviewAnsweredCard[] | null>(null)
  const [head, setHead] = useState<Pick<ReviewAnswersSince, 'total' | 'kept' | 'thrownAway'> | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [focus, setFocus] = useState(0)
  const [retraining, setRetraining] = useState<number | null>(null)
  const orig = useRef(new Map<string, 'keep' | 'throwaway'>()) // each tile's answer as main first gave it
  const undoStack = useRef<Undo[]>([])
  // a flip, an undo or Done's ask is being written: Done and the keys wait (`pending` shows it; the ref guards re-entry)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const hold = useCallback((on: boolean): void => {
    busy.current = on
    setPending(on)
  }, [])
  const loading = useRef(false)
  const st = useSorterStatus()

  const loadPage = useCallback(async (after: string | null): Promise<void> => {
    if (loading.current) return
    loading.current = true
    try {
      const r = await window.sw.review.answersSince(LOOK_SINCE, after, PAGE)
      for (const c of r.items) if (!orig.current.has(c.hash)) orig.current.set(c.hash, c.answer)
      if (!after) setHead({ total: r.total, kept: r.kept, thrownAway: r.thrownAway })
      setItems((prev) => {
        const have = new Set((prev ?? []).map((c) => c.hash))
        return [...(prev ?? []), ...r.items.filter((c) => !have.has(c.hash))]
      })
      setNext(r.next)
    } catch {
      onToast('Could not read your answers just now.')
    } finally {
      loading.current = false
    }
  }, [onToast])
  useEffect(() => {
    void loadPage(null)
  }, [loadPage])

  const shownItems = useMemo(() => (items ?? []).filter((c) => filter === 'all' || c.answer === filter), [items, filter])
  // live counts: main's counts at first read, moved by the flips made here
  const counts = useMemo(() => {
    let kept = head?.kept ?? 0
    let thrown = head?.thrownAway ?? 0
    for (const c of items ?? []) {
      const o = orig.current.get(c.hash)
      if (o && o !== c.answer) {
        if (c.answer === 'keep') (kept++, thrown--)
        else (kept--, thrown++)
      }
    }
    return { kept, thrown }
  }, [items, head])

  const setAnswer = useCallback((hash: string, answer: 'keep' | 'throwaway'): void => {
    setItems((prev) => (prev ?? []).map((c) => (c.hash === hash ? { ...c, answer } : c)))
  }, [])

  const flip = useCallback(
    async (card: ReviewAnsweredCard | undefined, to: 'keep' | 'throwaway'): Promise<void> => {
      if (!card || card.answer === to || busy.current || retraining !== null) return
      hold(true)
      try {
        // an answer in Throwaway or the Bin comes back with Rescue, as in the piles grid
        const r = await window.sw.review.act(card.hash, to === 'keep' && card.answer === 'throwaway' ? 'rescue' : to, shownPicture(card))
        onToast(r.message)
        if (r.ok) {
          noteAct(r.undoId, card.hash, 'look')
          if (typeof r.undoId === 'number') undoStack.current.push({ undoId: r.undoId, hash: card.hash, prev: card.answer })
          setAnswer(card.hash, to) // only a completed write counts as a change
          lookChanges += 1
        }
      } catch {
        onToast('That answer did not go through. Press the key again to try once more.')
      } finally {
        hold(false)
      }
    },
    [onToast, setAnswer, hold, retraining]
  )

  const undo = useCallback(async (): Promise<void> => {
    const e = undoStack.current[undoStack.current.length - 1]
    if (!e || busy.current || retraining !== null) return // only what was flipped here: nothing else of Review's history is undone from this view
    hold(true)
    try {
      const r = await window.sw.review.undo()
      onToast(r.message)
      if (r.ok) session.history = afterUndo(session.history, r.undoId) // the session's log of acts, wherever the act was made
      if (r.ok && r.undoId === e.undoId) {
        undoStack.current.pop()
        lookChanges -= 1
        setAnswer(e.hash, e.prev)
      }
    } catch {
      onToast('Undo did not go through; press ⌘Z to try again.')
    } finally {
      hold(false)
    }
  }, [onToast, setAnswer, hold, retraining])

  const done = useCallback(async (): Promise<void> => {
    if (busy.current || retraining !== null) return // a flip still being written is counted first
    if (lookChanges === 0) {
      markFinished()
      return onFinished()
    }
    hold(true)
    let asked: ReviewRetrainAsked
    try {
      asked = await window.sw.review.retrainAfterAnswers()
    } catch {
      asked = { ok: false }
    }
    if (!asked.ok || typeof asked.retrain !== 'number') {
      // not accepted: nothing is marked finished, and he can press Done again
      onToast(asked.error ? `${asked.error} Press Done again to try once more.` : ASK_FAILED)
      hold(false)
      return
    }
    const asking = lookChanges
    lookChanges = 0 // accepted: these changes are now owed to the sorter's training, not to this view
    markFinished()
    // a sorter doing other work keeps the training owed and starts it when it is free: no need to wait here
    if (st && st.phase !== 'idle' && st.phase !== 'error') {
      onToast(BUSY_WORDS)
      hold(false)
      return onFinished()
    }
    setRetraining(asking)
    try {
      const end = await window.sw.review.rescueRetrain(asked.retrain)
      if (end && !end.ok) onToast(end.error || 'The sorter could not retrain just now.')
    } catch {
      onToast('The sorter could not retrain just now.')
    }
    hold(false)
    onFinished()
  }, [onFinished, onToast, retraining, st, hold])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT') return
      if (document.querySelector('.overlay:not(.rv-confirm-overlay)')) return
      const cmd = e.metaKey || e.ctrlKey
      // while a flip is written or the retrain runs, K, T, ⌘Z and Esc do nothing (the arrows still move, but not while retraining)
      const k0 = e.key.toLowerCase()
      if (retraining !== null || (busy.current && (k0 === 'k' || k0 === 't' || k0 === 'z' || e.key === 'Escape'))) {
        if (!cmd || k0 === 'z') e.preventDefault()
        return
      }
      if (cmd && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undo()
        return
      }
      if (cmd || e.altKey) return
      const d = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS } as Record<string, number>)[e.key]
      const k = e.key.toLowerCase()
      if (d !== undefined) setFocus((f) => Math.max(0, Math.min(shownItems.length - 1, f + d)))
      else if (e.key === 'Escape') onBack()
      else if (k === 'k') void flip(shownItems[focus], 'keep')
      else if (k === 't') void flip(shownItems[focus], 'throwaway')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shownItems, focus, flip, undo, onBack, retraining])

  useEffect(() => {
    document.querySelector('.rv-la-grid .rv-focus')?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  useEffect(() => setFocus((f) => Math.max(0, Math.min(f, shownItems.length - 1))), [shownItems.length])

  // load more as the end of the grid scrolls into view
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !next) return
    const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && void loadPage(next))
    io.observe(el)
    return () => io.disconnect()
  }, [next, loadPage, items])

  const chip = (f: Filter, label: string): JSX.Element => (
    <button key={f} className={`rv-la-chip${filter === f ? ' on' : ''}`} aria-pressed={filter === f} data-testid={`look-chip-${f}`} onClick={() => { setFilter(f); setFocus(0) }}>{label}</button>
  )
  return (
    <div className="rv-screen" data-mode="again">
      <div className="rv-head mv-head">
        <h1>Look again · {head ? head.total : '…'} answers since {SINCE_WORDS}</h1>
        <span className="rv-sub" data-testid="look-counts">{head ? `${counts.kept} kept · ${counts.thrown} thrown away` : 'finding them…'}</span>
        {retraining !== null ? (
          <span className="rv-sub" data-testid="look-retraining">Changed {retraining}. Retraining…</span>
        ) : (
          <>
            <span className="rv-la-chips" role="group" aria-label="Show">{chip('all', 'All')}{chip('keep', 'Kept')}{chip('throwaway', 'Thrown away')}</span>
            <button className="rv-cancel" disabled={pending} onClick={onBack}>‹ Back to review</button>
            <button className="rv-back-btn" data-testid="look-done" disabled={pending} onClick={() => void done()}>Done — retrain</button>
          </>
        )}
      </div>
      <div className="rv-pl-main">
        <section className="rv-pl-left" style={{ width: '100%' }} aria-label="Your answers">
          <p className="rv-pl-note">Press <kbd>K</kbd> or <kbd>T</kbd> on any you would answer differently now. Anything you leave alone stays as it is.</p>
          <div className="rv-pgrid rv-la-grid">
            {shownItems.map((c, i) => (
              <div key={c.hash} className={`rv-pc${focus === i ? ' rv-focus' : ''}`} data-hash={c.hash} data-answer={c.answer} onClick={() => setFocus(i)}>
                <span className={`rv-tag ${c.answer === 'keep' ? 'you' : 'toss'}`} data-testid="look-badge">{c.answer === 'keep' ? 'kept' : 'thrown away'}</span>
                {orig.current.get(c.hash) !== c.answer && <span className="rv-la-changed" data-testid="look-changed">changed</span>}
                <Shot card={c} />
                <div className="rv-m" title={c.reason}>
                  <b>{c.filename}</b>
                  <span>{takenLine(c)}</span>
                </div>
                {focus === i && (
                  <div className="rv-pc-acts">
                    <button onClick={(e) => { e.stopPropagation(); void flip(c, c.answer === 'keep' ? 'throwaway' : 'keep') }}>
                      <kbd>{c.answer === 'keep' ? 'T' : 'K'}</kbd> {c.answer === 'keep' ? 'Throw away' : 'Keep'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {items && shownItems.length === 0 && <div className="rv-quiet">{items.length === 0 ? 'No answers to look at.' : 'None of the answers loaded so far match.'}</div>}
          {next && <div ref={sentinel} className="rv-la-more" data-testid="look-more">loading more…</div>}
        </section>
      </div>
      <div className="rv-hints">
        <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>K</kbd> keep</span>
        <span><kbd>T</kbd> throwaway</span>
        <span><kbd>⌘Z</kbd> undo</span>
        <span><kbd>Esc</kbd> back to review</span>
      </div>
    </div>
  )
}
