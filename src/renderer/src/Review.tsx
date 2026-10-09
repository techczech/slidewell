// Review tab (ticket 08, locked frames 1 and 2): the doubtful queue first, one large card at a time;
// "Show both piles" switches to slide material + throwaway, with the 30-day Bin behind the throwaway
// column. Every write goes through window.sw.review; skipping writes nothing (the item stays kept).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewCard, ReviewOverview, ReviewPiles } from '../../preload'

type PileName = 'kept' | 'throwaway' | 'bin'
const PAGE = 60

/** Page through one pile until `want` items (or all of them) are in hand. No cap. */
async function fetchUpTo(pile: PileName, first: ReviewCard[], total: number, want: number): Promise<ReviewCard[]> {
  let items = first
  while (items.length < Math.min(want, total)) {
    const pg = await window.sw.review.page(pile, items.length, 500)
    if (!pg.items.length) break
    items = items.concat(pg.items)
  }
  return items
}
import './review.css'

type Mode = 'doubtful' | 'piles'
type Column = 'kept' | 'right'
const KEPT_COLS = 4

const days = (n: number | null): string => (n === 1 ? 'bin in 1 day' : `bin in ${n ?? 30} days`)

/** "today at 02:00", "yesterday at 21:10", "on 7 Oct at 02:00". */
export function sortedWhen(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diff === 0) return `today at ${hm}`
  if (diff === 1) return d.getHours() < 6 ? `last night at ${hm}` : `yesterday at ${hm}`
  return `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${hm}`
}

function takenLabel(c: ReviewCard): string {
  if (!c.takenAt) return ''
  const d = new Date(c.takenAt)
  if (Number.isNaN(d.getTime())) return c.takenAt
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

function tone(hash: string): string {
  let h = 0
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0
  return `g${(h % 6) + 1}`
}

/** The picture, or a quiet placeholder window when there is none (not downloaded, or the preview). */
function Shot({ card, caption, className = '' }: { card: ReviewCard; caption?: string; className?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const dark = card.app === 'Terminal'
  return (
    <div className={`rv-shot ${dark ? 't2' : tone(card.hash)} ${className}`}>
      {card.thumbUrl && !failed ? (
        <img src={card.thumbUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className={`rv-win ${dark ? 't2' : tone(card.hash + 'w')}`} />
      )}
      {card.offline && <span className="rv-what">not downloaded</span>}
      {!card.offline && caption && <span className="rv-what">{caption}</span>}
    </div>
  )
}

const title = (c: ReviewCard): string => [c.app, c.windowTitle].filter(Boolean).join(' · ') || c.filename

export function ReviewScreen({ onCount, onToast }: { onCount: (n: number) => void; onToast: (m: string) => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>('doubtful')
  const [ov, setOv] = useState<ReviewOverview | null>(null)
  const [piles, setPiles] = useState<ReviewPiles | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [front, setFront] = useState<string | null>(null)
  const [stripOpen, setStripOpen] = useState(false)
  const [right, setRight] = useState<'throwaway' | 'bin'>('throwaway')
  const [focus, setFocus] = useState<{ col: Column; index: number }>({ col: 'kept', index: 0 })
  const [shown, setShown] = useState<Record<PileName, number>>({ kept: PAGE, throwaway: PAGE, bin: PAGE })
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const busy = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    const o = await window.sw.review.overview({ queue: 50, sample: 12 })
    setOv(o)
    onCount(o.needALook)
    if (mode === 'piles') {
      const p = await window.sw.review.piles({ kept: PAGE, throwaway: PAGE, bin: PAGE })
      const [kept, throwaway, bin] = await Promise.all(
        (['kept', 'throwaway', 'bin'] as const).map((k) => fetchUpTo(k, p[k].items, p[k].total, shown[k]))
      )
      setPiles({ ...p, kept: { ...p.kept, items: kept }, throwaway: { ...p.throwaway, items: throwaway }, bin: { ...p.bin, items: bin } })
    }
  }, [mode, shown, onCount])

  useEffect(() => {
    void load()
  }, [load])

  // a finished sort brings new proposals
  useEffect(() => {
    let last = ''
    return window.sw.sorter.onStatus((st) => {
      if (last && last !== 'idle' && st.phase === 'idle') void load()
      last = st.phase
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
        await load()
      } finally {
        busy.current = false
      }
    },
    [load, onToast, front]
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
      await load()
    } finally {
      busy.current = false
    }
  }, [load, onToast])

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
    if (!piles) return
    setConfirmEmpty(false)
    const r = await window.sw.review.emptyBin(piles.bin.token)
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
          setConfirmEmpty(false)
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

  if (mode === 'piles') {
    return (
      <div className="rv-screen" data-mode="piles">
        <div className="rv-head">
          <h1>Both piles</h1>
          <span className="rv-sub">
            {confidentTotal} sorted{when ? ` ${when}` : ''} · {ov.needALook} still need a look
          </span>
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
                  <div className="rv-m">
                    <b>{c.app || c.filename}</b>
                    <span>{c.windowTitle || (c.app ? c.filename : '')}</span>
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
                  <div className="rv-tr-text">
                    <b>{c.app || c.filename}</b>
                    <span>{c.windowTitle || (c.app ? c.filename : '')}</span>
                    <em>{c.pile === 'bin' ? 'in the Bin' : days(c.binInDays)}</em>
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
                <button className="rv-empty-btn" disabled={!piles?.bin.total} onClick={() => setConfirmEmpty(true)}>
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
        {confirmEmpty && piles && (
          <div className="overlay rv-confirm-overlay" onClick={() => setConfirmEmpty(false)}>
            <div className="rv-confirm" role="dialog" aria-label="Empty the Bin" onClick={(e) => e.stopPropagation()}>
              <h3>Hide {piles.bin.total} {piles.bin.total === 1 ? 'screenshot' : 'screenshots'} for good?</h3>
              <p>
                <b>Emptying the Bin hides these for good. SlideWell never deletes your files.</b>
              </p>
              <p>They disappear from Review, Triage and search and cannot be rescued afterwards. The files stay where they are; delete them yourself if you want them gone.</p>
              <div className="rv-confirm-btns">
                <button className="rv-cancel" autoFocus onClick={() => setConfirmEmpty(false)}>Cancel</button>
                <button className="rv-danger" onClick={() => void emptyBin()}>Hide {piles.bin.total} for good</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rv-screen" data-mode="doubtful">
      <div className="rv-head">
        <h1>{ov.needALook} need a look</h1>
        <span className="rv-sub">{confidentTotal} sorted confidently</span>
        {when && <span className="rv-when">· sorted {when}</span>}
        <button className="rv-pile-btn" onClick={openPiles}>
          <span className="rv-icon"><i /><i /></span>Show both piles
        </button>
      </div>
      <div className="rv-main">
        {current ? (
          <div className="rv-big" data-hash={current.hash}>
            <Shot card={current} caption={takenLabel(current)} className="rv-big-shot" />
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
              <p className="rv-why">{current.reason}</p>
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
          <h3>Up next · {Math.max(0, ov.needALook - 1)}</h3>
          {queue.slice(1, 6).map((c, i) => (
            <div className="rv-up" key={c.hash} data-hash={c.hash}>
              <Shot card={c} />
              <div>
                <div className="rv-un">{title(c)}</div>
                <div className="rv-ur">{c.reason}</div>
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
              <div className="rv-sample" key={c.hash} title={c.reason}>
                <Shot card={c} />
                <span className={c.pile === 'kept' ? 'rv-lbl keep' : 'rv-lbl toss'}>{c.pile === 'kept' ? 'kept' : c.pile === 'bin' ? 'in the Bin' : days(c.binInDays)}</span>
                <span className="rv-sample-t">{title(c)}</span>
              </div>
            ))}
            <button className="rv-link" onClick={openPiles}>All of them in both piles ›</button>
          </div>
        )}
      </div>
    </div>
  )
}
