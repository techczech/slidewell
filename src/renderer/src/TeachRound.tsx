// The round of ten (ticket 24, frames A1 and A2): up to ten of the screenshots the sorter is least sure about, one large
// at a time. Each Keep / Throw away is the real decision (the same review.act Review's buttons send). After the last
// answer the sorter retrains (trigger 'round') and the result says what moved. Keys are bound on the dialog, not the
// window: K keep, T throw away, ↓ skip, Esc leave (Return = Another 10 on the result).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewCard, SorterStatus } from '../../preload'
import { Shot, shownPicture } from './ReviewShot'
import { TeachRoundResult, type RoundOutcome } from './TeachRoundResult'
import { certainty, TRAIN_LINK, trainingState, untrainedSentence } from './teach-format'
import { closeTeachingRound, showMovedInReview, useTeachingRoundOpen } from './teach-round'
import './teach-round.css'

const SIZE = 10
type Answer = 'keep' | 'throwaway' | 'skipped'
type Entry = { card: ReviewCard; answer: Answer | null }
type Phase = 'loading' | 'asking' | 'nothing' | 'finishing' | 'result'

const titleOf = (c: ReviewCard): string => [c.app, c.windowTitle].filter(Boolean).join(', ') || c.filename
const ANSWER_WORDS: Record<Answer, string> = { keep: 'Keep', throwaway: 'Thrown away', skipped: 'Skipped' }

/** Waits until no retrain is running, then returns the status. */
function untilIdle(): Promise<SorterStatus> {
  return new Promise((resolve) => {
    let off = (): void => undefined
    const check = (s: SorterStatus): void => {
      if (s.retraining === null) {
        off()
        resolve(s)
      }
    }
    off = window.sw.sorter.onStatus(check)
    void window.sw.sorter.status().then(check)
  })
}

async function finish(entries: Entry[], startedAt: string): Promise<RoundOutcome> {
  const kept = entries.filter((e) => e.answer === 'keep').length
  const thrown = entries.filter((e) => e.answer === 'throwaway').length
  if (kept + thrown === 0) return { kind: 'none-answered' }
  const before = await window.sw.sorter.status()
  if (before.choicesNeeded > 0) return { kind: 'needs-more', answered: kept + thrown, need: before.choicesNeeded }
  const res = await window.sw.sorter.retrainNow('round')
  if (res.cancelled) return { kind: 'failed', answered: kept + thrown, message: 'Retraining was cancelled.' }
  if (!res.ok) {
    // a retrain that started by itself after ten answers may already be running: wait for it and show its result
    const s = await window.sw.sorter.status()
    if (s.retraining === null) return { kind: 'failed', answered: kept + thrown, message: res.error ?? 'The sorter could not retrain just now.' }
  }
  const st = await untilIdle()
  const r = st.lastRetrain
  if (!r || r.at < startedAt) return { kind: 'failed', answered: kept + thrown, message: res.error ?? 'The sorter did not retrain.' }
  return { kind: 'retrained', retrain: r, status: st, kept, thrown }
}

export function TeachRoundHost({ onShowReview, onOpenAutoSorting }: { onShowReview: () => void; onOpenAutoSorting: () => void }): JSX.Element | null {
  const open = useTeachingRoundOpen()
  return open ? <TeachRound onShowReview={onShowReview} onOpenAutoSorting={onOpenAutoSorting} /> : null
}

function TeachRound({ onShowReview, onOpenAutoSorting }: { onShowReview: () => void; onOpenAutoSorting: () => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [entries, setEntries] = useState<Entry[]>([])
  const [outcome, setOutcome] = useState<RoundOutcome | null>(null)
  const [waiting, setWaiting] = useState(0) // how many unsure ones are left to ask about, for the result
  const [error, setError] = useState<string | null>(null)
  const [st, setSt] = useState<SorterStatus | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const live = useRef(true)
  const startedAt = useRef('')

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    let on = true
    void window.sw.sorter.status().then((s) => on && setSt(s))
    const off = window.sw.sorter.onStatus((s) => setSt(s))
    return () => {
      on = false
      off()
    }
  }, [])

  const begin = useCallback(async (): Promise<void> => {
    setPhase('loading')
    setError(null)
    setOutcome(null)
    const q = await window.sw.sorter.teachQueue(undefined, SIZE)
    if (!live.current) return
    const items = q.items.slice(0, SIZE)
    setWaiting(q.total)
    setEntries(items.map((card) => ({ card, answer: null })))
    startedAt.current = new Date().toISOString()
    setPhase(items.length === 0 ? 'nothing' : 'asking')
  }, [])
  useEffect(() => {
    void begin()
  }, [begin])
  useEffect(() => dialog.current?.focus(), [phase, entries])

  const index = entries.findIndex((e) => e.answer === null)
  const current = phase === 'asking' && index >= 0 ? entries[index] : null

  const record = async (answer: Answer): Promise<void> => {
    if (!current || busy.current) return
    busy.current = true
    setError(null)
    try {
      if (answer !== 'skipped') {
        const r = await window.sw.review.act(current.card.hash, answer, shownPicture(current.card)) // the picture as he saw it
        if (!live.current) return
        if (!r.ok) {
          setError(r.message)
          return
        }
      }
      const next = entries.map((e, i) => (i === index ? { ...e, answer } : e))
      setEntries(next)
      if (next.every((e) => e.answer !== null)) {
        setPhase('finishing')
        const o = await finish(next, startedAt.current)
        if (!live.current) return
        const q = await window.sw.sorter.teachQueue(undefined, 1)
        if (!live.current) return
        setWaiting(q.total)
        setOutcome(o)
        setPhase('result')
      }
    } finally {
      busy.current = false
    }
  }

  const done = (): void => closeTeachingRound()
  // Esc leaves the round in every state, wherever the focus is: heard on the window in the capture phase (before any
  // document or element listener), so a panel under the round cannot take it first
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeTeachingRound()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const seeMoved = (hashes: string[]): void => {
    onShowReview()
    showMovedInReview(hashes)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation() // Review's and Triage's keys do not fire while the round is open
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      done()
      return
    }
    if (phase === 'asking') {
      const k = e.key.toLowerCase()
      if (k === 'k') void record('keep')
      else if (k === 't') void record('throwaway')
      else if (e.key === 'ArrowDown') void record('skipped')
      else return
      e.preventDefault()
    } else if (phase === 'result' && e.key === 'Enter' && !(e.target as HTMLElement).closest('button') && waiting > 0) {
      e.preventDefault()
      void begin()
    }
  }

  const c = current?.card
  const cert = c ? certainty(c.pKeep, c.leans) : null
  const t = st?.report?.thresholds
  const need = c && t ? Math.round((c.leans === 'keep' ? t.keep : t.throwaway) * 100) : null
  const total = entries.length
  // no current model: nothing can be learnt from answers, so the round says so instead of asking (not once answers are in)
  const untrained = st && phase !== 'finishing' && phase !== 'result' && entries.every((e) => e.answer === null) ? trainingState(st) : null

  return (
    <div className="overlay tr-round-overlay">
      <div ref={dialog} className="tr-round" role="dialog" aria-modal="true" aria-label="Teaching round" tabIndex={-1} data-phase={phase} onKeyDown={onKeyDown}>
        {untrained ? (
          <div className="tr-quiet" data-testid="round-untrained">
            <h1>Teaching round</h1>
            <p>{untrainedSentence(untrained)}</p>
            <button className="ts-link tr-train-link" onClick={() => { done(); onOpenAutoSorting() }}>{TRAIN_LINK}</button>
            <p><button className="tr-sec" onClick={done}>Done <kbd>Esc</kbd></button></p>
          </div>
        ) : phase === 'result' && outcome ? (
          <TeachRoundResult outcome={outcome} waiting={waiting} onAnother={() => void begin()} onDone={done} onSeeMoved={seeMoved} />
        ) : phase === 'nothing' ? (
          <div className="tr-quiet" data-testid="round-nothing">
            <h1>Teaching round</h1>
            <p>There is nothing unsure to ask about. The sorter was sure about every screenshot you have not decided yet.</p>
            <button className="tr-sec" onClick={done}>Done <kbd>Esc</kbd></button>
          </div>
        ) : phase === 'loading' ? (
          <div className="tr-quiet"><p>Finding the ones it is least sure about…</p></div>
        ) : (
          <>
            <div className="tr-head">
              <h1>Teaching round</h1>
              <span className="tr-count" data-testid="round-count">{phase === 'finishing' ? `${total} of ${total}` : `${index + 1} of ${total}`}</span>
              <button className="tr-sec tr-end" onClick={done}>End round</button>
            </div>
            <div className="tr-seg" aria-hidden="true">
              {entries.map((e, i) => (
                <i key={e.card.hash} className={e.answer === 'skipped' ? 's' : e.answer ? 'd' : i === index ? 'c' : ''} />
              ))}
            </div>
            {total < SIZE && <p className="tr-short">Only {total} {total === 1 ? 'screenshot is' : 'screenshots are'} unsure, so this round has {total}.</p>}
            <div className="tr-main">
              <div className="tr-big" data-hash={c?.hash}>
                {c && cert ? (
                  <>
                    <Shot key={c.hash} card={c} caption={titleOf(c)} className="tr-shot" />
                    <div className="tr-body">
                      <div className="tr-rl">The sorter&apos;s guess</div>
                      <div className="tr-cert">
                        <div className="tr-cert-head">Leaning {cert.lean}, <b>{cert.sure}% sure</b></div>
                        <div className="rv-cbar" role="img" aria-label={`Keep ${cert.keep}%, throwaway ${cert.throwaway}%`}>
                          <div className="k" style={{ width: `${cert.keep}%` }} />
                          <div className="t" style={{ width: `${cert.throwaway}%` }} />
                        </div>
                        <div className="rv-cbar-lab">
                          <span><b>Keep</b> {cert.keep}%</span>
                          <span><b>Throwaway</b> {cert.throwaway}%</span>
                        </div>
                        {need !== null && <p className="tr-cert-note">It calls something {cert.lean} on its own only at {need}% or more.</p>}
                      </div>
                      <div className="tr-rl tr-why-l">Why</div>
                      <p className="tr-why">{c.why || c.reason}</p>
                      {error && <p className="tr-error" role="alert">{error}</p>}
                      <div className="tr-btns">
                        <button className="tr-answer keep" onClick={() => void record('keep')}>
                          <kbd>K</kbd>
                          <span>Keep<small>slide material</small></span>
                        </button>
                        <button className="tr-answer toss" onClick={() => void record('throwaway')}>
                          <kbd>T</kbd>
                          <span>Throw away<small>to the Throwaway pile</small></span>
                        </button>
                      </div>
                      <div className="tr-skip">
                        <button className="tr-skip-btn" onClick={() => void record('skipped')}><kbd>↓</kbd> Skip</button>
                        <span>skipped ones stay in the Review queue</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="tr-working" role="status">Retraining the sorter on your answers… this can take a little while.</p>
                )}
              </div>
              <aside className="tr-side">
                <h3>Why these {total === SIZE ? 'ten' : total}</h3>
                <p>These are the ones the sorter is least sure about. Your answer to each teaches it the most.</p>
                <p className="tr-side-note">Each answer is also a real choice: Keep keeps the screenshot, Throw away puts it in the Throwaway pile. After the last, the sorter retrains and shows what changed.</p>
                <h3 className="tr-list-h">This round</h3>
                <ol className="tr-list" data-testid="round-list">
                  {entries.map((e, i) => (
                    <li key={e.card.hash} className={i === index && phase === 'asking' ? 'cur' : e.answer === null ? 'todo' : ''} data-answer={e.answer ?? ''}>
                      <span className="i">{i + 1}</span>
                      {titleOf(e.card)}
                      {e.answer && <span className={`ans ${e.answer}`}>{ANSWER_WORDS[e.answer]}</span>}
                    </li>
                  ))}
                </ol>
              </aside>
            </div>
            <div className="tr-hints">
              <span><kbd>K</kbd> keep</span>
              <span><kbd>T</kbd> throw away</span>
              <span><kbd>↓</kbd> skip</span>
              <span><kbd>Esc</kbd> end round</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
