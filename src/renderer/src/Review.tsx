// Review tab (ticket 08, locked frames 1 and 2): the doubtful queue first, one large card at a time;
// "Show both piles" switches to slide material + throwaway, with the 30-day Bin behind the throwaway
// column. Every write goes through window.sw.review; skipping writes nothing (the item stays kept).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewCard, ReviewOverview, ReviewPiles, ReviewSure } from '../../preload'
import { ReviewMoved } from './ReviewMoved'
import { Shot } from './ReviewShot'
import { ReviewStrip } from './ReviewStrip'
import { SureFilter, sureWords, pctOf } from './ReviewSure'
import { onMovedRequest, takePendingMoved } from './teach-round'
import { useSorterStatus } from './sorter-hooks'
import { certainty, upNextHeading, whenWords } from './teach-format'

type PileName = 'kept' | 'throwaway' | 'bin'
const PAGE = 60

/**
 * Page through one pile (keyset cursors) until `want` items are in hand or the pile ends. No cap.
 * Pages are joined by hash, so an item that moved between pages is never shown twice.
 */
async function fetchUpTo(pile: PileName, first: ReviewCard[], next: string | null, want: number, sure?: ReviewSure): Promise<ReviewCard[]> {
  const seen = new Set(first.map((c) => c.hash))
  const items = [...first]
  let cursor = next
  while (items.length < want && cursor) {
    const pg = await window.sw.review.page(pile, cursor, 500, sure)
    for (const c of pg.items) if (!seen.has(c.hash)) (seen.add(c.hash), items.push(c))
    cursor = pg.next
  }
  return items
}
import './review.css'
import './teach.css'

// The how-sure range lives for the session (until the window closes): kept here so leaving Review and coming back keeps it. Never saved.
let sessionSure: ReviewSure | null = null

type Mode = 'doubtful' | 'piles' | 'moved'
const TEACH_KEY = 'sw.review.teachFirst' // remembered in this profile's own storage; on unless he switched it off
type Column = 'kept' | 'right'
const KEPT_COLS = 4

const days = (n: number | null): string => (n === 1 ? 'bin in 1 day' : `bin in ${n ?? 30} days`)

/** "today at 02:00", "yesterday at 21:10", "on 7 Oct at 02:00" (teach-format.ts whenWords). */
export const sortedWhen = (iso: string | null, now = new Date()): string => whenWords(iso, now)

function takenLabel(c: ReviewCard): string {
  if (!c.takenAt) return ''
  const d = new Date(c.takenAt)
  if (Number.isNaN(d.getTime())) return c.takenAt
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

// Which sorter step made the call (tickets 07, 16), in the words the card shows.
const STEP_WORDS: Record<NonNullable<ReviewCard['decidedBy']>, string> = { rules: 'by rules', history: 'by your history', luna: 'asked Luna', haiku: 'asked Haiku' }
const ASKED: Partial<Record<NonNullable<ReviewCard['decidedBy']>, string>> = { luna: 'asked Luna', haiku: 'asked Haiku' }
const asked = (by: ReviewCard['decidedBy']): string | null => (by ? (ASKED[by] ?? null) : null)
const step = (c: ReviewCard): string | null => (c.by === 'sorter' && c.decidedBy ? STEP_WORDS[c.decidedBy] : null)
function Step({ card }: { card: ReviewCard }): JSX.Element | null {
  const w = step(card)
  return w ? <span className={`rv-step${asked(card.decidedBy) ? ' luna' : ''}`}>{w}</span> : null
}
const title = (c: ReviewCard): string => [c.app, c.windowTitle].filter(Boolean).join(' · ') || c.filename

export function ReviewScreen({ onCount, onToast, onOpenAutoSorting }: { onCount: (n: number) => void; onToast: (m: string) => void; onOpenAutoSorting: () => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>('doubtful')
  const [ov, setOv] = useState<ReviewOverview | null>(null)
  const [piles, setPiles] = useState<ReviewPiles | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [front, setFront] = useState<string | null>(null)
  const [stripOpen, setStripOpen] = useState(false)
  const [right, setRight] = useState<'throwaway' | 'bin'>('throwaway')
  const [focus, setFocus] = useState<{ col: Column; index: number }>({ col: 'kept', index: 0 })
  const [shown, setShown] = useState<Record<PileName, number>>({ kept: PAGE, throwaway: PAGE, bin: PAGE })
  // the Bin he is asked about: the count and the token of one unfiltered piles answer, taken together when the confirm opens
  const [confirmEmpty, setConfirmEmpty] = useState<{ total: number; token: string } | null>(null)
  const [teachFirst, setTeachFirst] = useState(() => localStorage.getItem(TEACH_KEY) !== 'off')
  const [movedHashes, setMovedHashes] = useState<string[]>([])
  const [sure, setSureState] = useState<ReviewSure | null>(sessionSure)
  const setSure = useCallback((r: ReviewSure | null): void => {
    sessionSure = r
    setSureState(r)
  }, [])
  const st = useSorterStatus()
  const busy = useRef(false)
  // Every load takes a number; only the newest one may publish. A load that a newer one (another range, Show all, an answer)
  // has overtaken drops its overview, piles and pages, however late they arrive.
  const generation = useRef(0)

  // "See what moved" from the end of a teaching round: open the moved view, as the strip's link does
  useEffect(() => {
    const apply = (): void => {
      const h = takePendingMoved()
      if (h) {
        setMovedHashes(h)
        setMode('moved')
      }
    }
    apply()
    return onMovedRequest(apply)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    const stillNewest = (): boolean => mine === generation.current
    const o = await window.sw.review.overview({ queue: 50, sample: 12, order: teachFirst ? 'teach' : 'newest', ...(sure ? { sure } : {}) })
    if (!stillNewest()) return
    setOv(o)
    onCount(o.all.needALook) // the tab's count is never filtered
    if (mode === 'piles') {
      const p = await window.sw.review.piles({ kept: PAGE, throwaway: PAGE, bin: PAGE, ...(sure ? { sure } : {}) })
      if (!stillNewest()) return
      const [kept, throwaway, bin] = await Promise.all(
        (['kept', 'throwaway', 'bin'] as const).map((k) => fetchUpTo(k, p[k].items, p[k].next, shown[k], sure ?? undefined))
      )
      if (!stillNewest()) return
      setPiles({ ...p, kept: { ...p.kept, items: kept }, throwaway: { ...p.throwaway, items: throwaway }, bin: { ...p.bin, items: bin } })
    }
  }, [mode, shown, onCount, teachFirst, sure])
  // An answer or undo reads the queue again when its write returns. That may be after the range changed, so it must
  // call the latest load (this render's range), not the one captured when the answer began.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    void load()
  }, [load])

  // a finished sort brings new proposals
  useEffect(() => {
    let last = ''
    let lastRetrain: string | null | undefined
    let retraining: string | null = null
    return window.sw.sorter.onStatus((s) => {
      if (last && last !== 'idle' && s.phase === 'idle') void load()
      // a retrain that has just ended re-scores the queue: read it again
      else if (retraining && !s.retraining) void load()
      else if (lastRetrain !== undefined && (s.lastRetrain?.at ?? null) !== lastRetrain) void load()
      last = s.phase
      lastRetrain = s.lastRetrain?.at ?? null
      retraining = s.retraining
    })
  }, [load])

  const queue = useMemo(() => {
    const q = ov?.queue ?? []
    const sk = new Set(skipped)
    const main = q.filter((c) => !sk.has(c.hash))
    const tail = skipped.map((h) => q.find((c) => c.hash === h)).filter((c): c is ReviewCard => Boolean(c))
    const ordered = [...main, ...tail]
    const f = front ? ordered.findIndex((c) => c.hash === front) : -1
    if (f > 0) ordered.unshift(...ordered.splice(f, 1))
    return ordered
  }, [ov, skipped, front])
  const current = queue[0] ?? null

  const act = useCallback(
    async (card: ReviewCard | null, action: 'keep' | 'throwaway' | 'rescue'): Promise<void> => {
      if (!card || busy.current) return
      busy.current = true
      try {
        const r = await window.sw.review.act(card.hash, action)
        onToast(r.message)
        if (r.ok) {
          setSkipped((s) => s.filter((h) => h !== card.hash))
          if (front === card.hash) setFront(null)
        }
      } catch {
        onToast('That answer did not go through. Press the key again to try once more.')
      } finally {
        // read the queue again whatever happened: an answer that was written but answered with an error must not leave its card on screen
        await loadRef.current().catch(() => undefined)
        busy.current = false
      }
    },
    [onToast, front]
  )

  const undo = useCallback(async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      const r = await window.sw.review.undo()
      onToast(r.message)
      if (r.ok && r.hash) {
        setSkipped((s) => s.filter((h) => h !== r.hash))
        setFront(r.hash)
      }
    } catch {
      onToast('Undo did not go through; press ⌘Z to try again.')
    } finally {
      await loadRef.current().catch(() => undefined)
      busy.current = false
    }
  }, [onToast])

  const skip = useCallback((): void => {
    if (!current) return
    setFront(null)
    setSkipped((s) => [...s.filter((h) => h !== current.hash), current.hash])
  }, [current])
  const unskip = useCallback((): void => {
    if (!skipped.length) return
    setFront(skipped[skipped.length - 1])
    setSkipped(skipped.slice(0, -1))
  }, [skipped])

  const openPiles = (): void => {
    setMode('piles')
    setFocus({ col: 'kept', index: 0 })
  }

  const rightItems = (right === 'throwaway' ? piles?.throwaway.items : piles?.bin.items) ?? []
  const keptItems = piles?.kept.items ?? []
  const focusedCard: ReviewCard | null = focus.col === 'kept' ? keptItems[focus.index] ?? null : rightItems[focus.index] ?? null

  // keep focus on a real card as piles change
  useEffect(() => {
    const len = focus.col === 'kept' ? keptItems.length : rightItems.length
    if (len && focus.index >= len) setFocus({ col: focus.col, index: len - 1 })
  }, [keptItems.length, rightItems.length, focus])

  const emptyBin = async (): Promise<void> => {
    if (!confirmEmpty) return
    const { token } = confirmEmpty
    setConfirmEmpty(null)
    const r = await window.sw.review.emptyBin(token)
    onToast(r.message)
    await load()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT') return
      // a panel opened from the title bar (Triage, Settings, Help…) owns the keyboard while open
      if (document.querySelector('.overlay:not(.rv-confirm-overlay)')) return
      const cmd = e.metaKey || e.ctrlKey
      if (confirmEmpty) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setConfirmEmpty(null)
        }
        return
      }
      if (cmd && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undo()
        return
      }
      if (cmd || e.altKey) return
      const k = e.key.toLowerCase()
      if (mode === 'moved') return
      if (mode === 'doubtful') {
        if (k === 'k') void act(current, 'keep')
        else if (k === 't') void act(current, 'throwaway')
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') skip()
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') unskip()
        else return
        e.preventDefault()
        return
      }
      // both piles
      const len = focus.col === 'kept' ? keptItems.length : rightItems.length
      const step = focus.col === 'kept' ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -KEPT_COLS, ArrowDown: KEPT_COLS } : { ArrowLeft: 0, ArrowRight: 0, ArrowUp: -1, ArrowDown: 1 }
      if (e.key in step) {
        const d = step[e.key as keyof typeof step]
        if (focus.col === 'kept' && e.key === 'ArrowRight' && (focus.index % KEPT_COLS === KEPT_COLS - 1 || focus.index === len - 1)) setFocus({ col: 'right', index: 0 })
        else if (focus.col === 'right' && e.key === 'ArrowLeft') setFocus({ col: 'kept', index: 0 })
        else if (len) setFocus({ col: focus.col, index: Math.max(0, Math.min(len - 1, focus.index + d)) })
      } else if (e.key === 'Tab') setFocus({ col: focus.col === 'kept' ? 'right' : 'kept', index: 0 })
      else if (e.key === 'Escape') setMode('doubtful')
      else if (k === 'k') void act(focusedCard, focusedCard && focusedCard.pile !== 'kept' ? 'rescue' : 'keep')
      else if (k === 't') void act(focusedCard, 'throwaway')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, current, act, undo, skip, unskip, focus, keptItems.length, rightItems.length, focusedCard, confirmEmpty])

  useEffect(() => {
    document.querySelector('.rv-focus')?.scrollIntoView({ block: 'nearest' })
  }, [focus, mode])

  if (!ov) return <div className="rv-screen"><div className="rv-loading">loading…</div></div>

  const when = sortedWhen(ov.lastSortedAt)
  const confidentTotal = ov.confident.kept + ov.confident.throwaway
  const sureCounts = { needALook: ov.needALook, needAll: ov.all.needALook, confident: confidentTotal, confidentAll: ov.all.confident }
  const sureTag = sure ? ` · how sure ${sureWords(sure)}` : ''
  const sureFilter = <SureFilter value={sure} onChange={setSure} counts={sureCounts} />

  if (mode === 'moved') return <ReviewMoved hashes={movedHashes} onBack={() => setMode('doubtful')} />

  if (mode === 'piles') {
    return (
      <div className="rv-screen" data-mode="piles">
        <div className="rv-head">
          <h1>Both piles{sureTag}</h1>
          <span className="rv-sub">
            {confidentTotal} sorted{when ? ` ${when}` : ''} · {ov.needALook} still need a look
          </span>
          {sureFilter}
          <button className="rv-back-btn" onClick={() => setMode('doubtful')}>
            ‹ Back to doubtful {ov.needALook > 0 && <span className="rv-n">{ov.needALook}</span>}
          </button>
        </div>
        <div className="rv-pl-main">
          <section className="rv-pl-left" aria-label="Slide material">
            <div className="rv-pl-h">
              <h2>Slide material</h2>
              <span className="rv-count">{piles?.kept.total ?? 0} · newest first</span>
            </div>
            <p className="rv-pl-note">Kept and searchable, and offered in TalkWeaver’s image drawer.</p>
            <div className="rv-pgrid">
              {keptItems.map((c, i) => (
                <div
                  key={c.hash}
                  className={`rv-pc${focus.col === 'kept' && focus.index === i ? ' rv-focus' : ''}`}
                  data-hash={c.hash}
                  onClick={() => setFocus({ col: 'kept', index: i })}
                >
                  {c.by === 'you' && <span className="rv-tag you">you kept</span>}
                  <Shot card={c} caption={takenLabel(c)} />
                  <div className="rv-m" title={c.reason}>
                    <b>{c.app || c.filename}</b>
                    <span>{c.windowTitle || (c.app ? c.filename : '')}</span>
                    <Step card={c} />
                  </div>
                  {focus.col === 'kept' && focus.index === i && (
                    <div className="rv-pc-acts">
                      <button onClick={(e) => { e.stopPropagation(); void act(c, 'throwaway') }}><kbd>T</kbd> Throwaway</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {piles && piles.kept.total > keptItems.length && (
              <button className="rv-more" onClick={() => setShown((s) => ({ ...s, kept: keptItems.length + PAGE }))}>
                Show more ({piles.kept.total - keptItems.length} not shown)
              </button>
            )}
          </section>
          <section className="rv-pl-right" aria-label={right === 'throwaway' ? 'Throwaway' : 'Bin'}>
            {right === 'throwaway' ? (
              <>
                <div className="rv-pl-h">
                  <h2>Throwaway</h2>
                  <span className="rv-count">{piles?.throwaway.total ?? 0}</span>
                </div>
                <p className="rv-pl-note">Moves to the Bin after 30 days unless you keep it. Your original files are not touched.</p>
              </>
            ) : (
              <>
                <div className="rv-pl-h">
                  <h2>Bin</h2>
                  <span className="rv-count">{piles?.bin.total ?? 0}</span>
                  <button className="rv-link" onClick={() => { setRight('throwaway'); setFocus({ col: 'right', index: 0 }) }}>‹ Throwaway</button>
                </div>
                <p className="rv-pl-note">Still here for you to rescue until you empty the Bin. Emptying the Bin hides these for good. SlideWell never deletes your files.</p>
              </>
            )}
            <div className="rv-tlist">
              {rightItems.map((c, i) => (
                <div
                  key={c.hash}
                  className={`rv-tr${focus.col === 'right' && focus.index === i ? ' rv-focus' : ''}`}
                  data-hash={c.hash}
                  onClick={() => setFocus({ col: 'right', index: i })}
                >
                  <Shot card={c} />
                  <div className="rv-tr-text" title={c.reason}>
                    <b>{c.app || c.filename}</b>
                    <span>{c.windowTitle || (c.app ? c.filename : '')}</span>
                    <em>{c.pile === 'bin' ? 'in the Bin' : days(c.binInDays)}</em>
                    <Step card={c} />
                  </div>
                  {focus.col === 'right' && focus.index === i && (
                    <button className="rv-rescue" onClick={(e) => { e.stopPropagation(); void act(c, 'rescue') }}><kbd>K</kbd> Keep</button>
                  )}
                </div>
              ))}
              {piles && piles[right].total > rightItems.length && (
                <button className="rv-more" onClick={() => setShown((s) => ({ ...s, [right]: rightItems.length + PAGE }))}>
                  Show more ({piles[right].total - rightItems.length} not shown)
                </button>
              )}
              {rightItems.length === 0 && <div className="rv-quiet">{right === 'throwaway' ? 'Nothing in Throwaway.' : 'The Bin is empty.'}</div>}
            </div>
            <div className="rv-bin-row">
              {right === 'throwaway' ? (
                <button className="rv-link" onClick={() => { setRight('bin'); setFocus({ col: 'right', index: 0 }) }}>
                  Bin · {piles?.bin.total ?? 0} ›
                </button>
              ) : (
                <button
                  className="rv-empty-btn"
                  // only piles read with no range carry the whole Bin's token; until those are on screen the button waits
                  disabled={!piles?.bin.token || !piles.bin.total}
                  title={piles && !piles.bin.token ? 'Show all in How sure to empty the Bin: it empties everything in it.' : undefined}
                  onClick={() => piles?.bin.token && setConfirmEmpty({ total: piles.bin.total, token: piles.bin.token })}
                >
                  Empty Bin…
                </button>
              )}
            </div>
          </section>
        </div>
        <div className="rv-hints">
          <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>K</kbd> keep</span>
          <span><kbd>T</kbd> throwaway</span>
          <span><kbd>Tab</kbd> switch pile</span>
          <span><kbd>⌘Z</kbd> undo</span>
          <span><kbd>Esc</kbd> back to doubtful</span>
        </div>
        {confirmEmpty && (
          <div className="overlay rv-confirm-overlay" onClick={() => setConfirmEmpty(null)}>
            <div className="rv-confirm" role="dialog" aria-label="Empty the Bin" onClick={(e) => e.stopPropagation()}>
              <h3>Hide {confirmEmpty.total} {confirmEmpty.total === 1 ? 'screenshot' : 'screenshots'} for good?</h3>
              <p>
                <b>Emptying the Bin hides these for good. SlideWell never deletes your files.</b>
              </p>
              <p>They disappear from Review, Triage and search and cannot be rescued afterwards. The files stay where they are; delete them yourself if you want them gone.</p>
              <div className="rv-confirm-btns">
                <button className="rv-cancel" autoFocus onClick={() => setConfirmEmpty(null)}>Cancel</button>
                <button className="rv-danger" onClick={() => void emptyBin()}>Hide {confirmEmpty.total} for good</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rv-screen" data-mode="doubtful">
      <ReviewStrip needALook={ov.all.needALook} onSeeMoved={(h) => { setMovedHashes(h); setMode('moved') }} onOpenAutoSorting={onOpenAutoSorting} onToast={onToast} />
      <div className="rv-head">
        <h1>{ov.needALook} need a look{sureTag}</h1>
        <span className="rv-sub">{confidentTotal} sorted confidently</span>
        {when && <span className="rv-when">· sorted {when}</span>}
        {sureFilter}
        <button
          className="rv-teach-switch"
          role="switch"
          aria-checked={teachFirst}
          onClick={() => {
            const on = !teachFirst
            localStorage.setItem(TEACH_KEY, on ? 'on' : 'off')
            setTeachFirst(on)
          }}
        >
          <span className="rv-tg" />
          Teaches most first
        </button>
        <button className="rv-pile-btn" onClick={openPiles}>
          <span className="rv-icon"><i /><i /></span>Show both piles
        </button>
      </div>
      <div className="rv-main">
        {current ? (
          <div className="rv-big" data-hash={current.hash}>
            <Shot key={current.hash} card={current} caption={takenLabel(current)} className="rv-big-shot" />
            <div className="rv-body">
              <div className="rv-fn">{current.filename}</div>
              <div className="rv-am">
                {current.app || current.windowTitle ? (
                  <>
                    <b>{current.app ?? ''}</b>
                    {current.app && current.windowTitle ? ' · ' : ''}
                    {current.windowTitle ?? ''}
                  </>
                ) : (
                  <span className="rv-muted">No app or window recorded</span>
                )}
              </div>
              <div className="rv-why-l">Why it is asking</div>
              <p className="rv-why">
                {current.why || current.reason}
                {asked(current.decidedBy) && <span className="rv-why-step"> · {asked(current.decidedBy)}</span>}
              </p>
              {(() => {
                const c = certainty(current.pKeep, current.leans)
                const t = st?.report?.thresholds
                const need = t ? Math.round((current.leans === 'keep' ? t.keep : t.throwaway) * 100) : null
                return (
                  <div className="rv-cert" data-testid="certainty">
                    <div className="rv-cert-head">
                      Leaning {c.lean}, <b>{c.sure}% sure</b>
                    </div>
                    <div className="rv-cbar" role="img" aria-label={`Keep ${c.keep}%, throwaway ${c.throwaway}%`}>
                      <div className="k" style={{ width: `${c.keep}%` }} />
                      <div className="t" style={{ width: `${c.throwaway}%` }} />
                    </div>
                    <div className="rv-cbar-lab">
                      <span><b>Keep</b> {c.keep}%</span>
                      <span><b>Throwaway</b> {c.throwaway}%</span>
                    </div>
                    <p className="rv-cert-note">
                      {need !== null ? `It counts as sure at ${need}%. ` : ''}Question 1 of {ov.needALook}{teachFirst ? ', most unsure first' : ''}.
                    </p>
                  </div>
                )
              })()}
              <p className="rv-lean">
                If you skip it, it stays <b>kept</b>. Only sure throwaways go to the Throwaway pile.
              </p>
              <div className="rv-btns">
                <button className="rv-btn-big keep" onClick={() => void act(current, 'keep')}>
                  <kbd>K</kbd>
                  <span>Keep<small>slide material</small></span>
                </button>
                <button className="rv-btn-big toss" onClick={() => void act(current, 'throwaway')}>
                  <kbd>T</kbd>
                  <span>Throwaway<small>bin in 30 days</small></span>
                </button>
              </div>
            </div>
          </div>
        ) : sure ? (
          <div className="rv-big rv-done" data-testid="sure-empty">
            <h2>{confidentTotal > 0 ? 'Nothing that needs a look' : 'Nothing in Review'} is between {pctOf(sure.min)}% and {pctOf(sure.max)}% sure.</h2>
            {confidentTotal > 0 && <p>Nothing needing a look is in this range; {confidentTotal} sorted confidently {confidentTotal === 1 ? 'is' : 'are'}, in the strip below.</p>}
            <button className="rv-sure-btn rv-sure-empty-btn" onClick={() => setSure(null)}>Show all</button>
          </div>
        ) : (
          <div className="rv-big rv-done">
            <h2>{ov.queue.length === 0 && confidentTotal === 0 ? 'Nothing sorted yet' : 'Nothing needs a look'}</h2>
            <p>
              {confidentTotal === 0 && ov.queue.length === 0
                ? 'Once the sorter has sorted your screenshots (Settings › Screenshot sorter), the ones it is unsure about appear here.'
                : 'The sorter was sure about everything else. Show both piles to check what it sorted.'}
            </p>
          </div>
        )}
        <aside className="rv-next">
          <h3>{upNextHeading(Math.min(5, Math.max(0, queue.length - 1)), ov.needALook, teachFirst)}</h3>
          {queue.slice(1, 6).map((c, i) => (
            <div className="rv-up" key={c.hash} data-hash={c.hash}>
              <Shot card={c} />
              <div className="rv-up-t">
                <div className="rv-un">{title(c)}</div>
                <div className="rv-ur">
                  {c.why || c.reason}
                  {asked(c.decidedBy) ? ` · ${asked(c.decidedBy)}` : ''}
                </div>
                <div className="rv-mini" role="img" aria-label={`Keep ${Math.round(c.pKeep * 100)}%, throwaway ${100 - Math.round(c.pKeep * 100)}%`}>
                  <div className="k" style={{ width: `${Math.round(c.pKeep * 100)}%` }} />
                  <div className="t" style={{ width: `${100 - Math.round(c.pKeep * 100)}%` }} />
                </div>
              </div>
              <span className="rv-num">{i + 2}</span>
            </div>
          ))}
          <div className="rv-keys">
            <kbd>K</kbd> keep &nbsp; <kbd>T</kbd> throwaway &nbsp; <kbd>↓</kbd> skip &nbsp; <kbd>⌘Z</kbd> undo
          </div>
        </aside>
      </div>
      <div className={`rv-strip${stripOpen ? ' open' : ''}`}>
        <div className="rv-strip-row" onClick={() => setStripOpen((o) => !o)}>
          <span className="rv-chev">{stripOpen ? '▾' : '▸'}</span>
          <b>{confidentTotal} sorted confidently</b>
          <span className="rv-sub">
            <span className="rv-dot keep" />
            {ov.confident.kept} kept &nbsp; <span className="rv-dot toss" />
            {ov.confident.throwaway} throwaway
          </span>
          {!stripOpen && (
            <span className="rv-minis">
              {ov.confidentSample.slice(0, 6).map((c) => (
                <Shot key={c.hash} card={c} />
              ))}
            </span>
          )}
          <button className="rv-show">{stripOpen ? 'hide' : 'show'}</button>
        </div>
        {stripOpen && (
          <div className="rv-strip-body">
            {ov.confidentSample.map((c) => (
              <div className="rv-sample" key={c.hash} title={step(c) ? `${c.reason} (${step(c)})` : c.reason}>
                <Shot card={c} />
                <span className={c.pile === 'kept' ? 'rv-lbl keep' : 'rv-lbl toss'}>{c.pile === 'kept' ? 'kept' : c.pile === 'bin' ? 'in the Bin' : days(c.binInDays)}</span>
                <span className="rv-sample-t">{title(c)}</span>
                <Step card={c} />
              </div>
            ))}
            <button className="rv-link" onClick={openPiles}>All of them in both piles ›</button>
          </div>
        )}
      </div>
    </div>
  )
}
