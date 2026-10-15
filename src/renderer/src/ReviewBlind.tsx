// A quiet banner under the sorter strip: Review answers given on screenshots that had no picture (main: review/rescue.ts):
// as recorded when he answered, or, for answers from before that record, as the picture is on this Mac now. The confirm
// lists every answer it puts back, from the same read as the counts and the token.
// Until the picture states, such cards showed a drawn stand-in that looked real. The banner offers to put those answers
// back to undecided and retrain; "Not now" hides it until the window closes. Main owns every count and the set behind
// the token; this only shows them and sends the token back.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewBlindAnswers, ReviewBlindItem } from '../../preload'

/** The teaching build (local time): answers before it are not looked at. */
export const BLIND_SINCE = '2026-10-13T00:00:00'

// "Not now" lasts for the session (until the window closes). Never saved.
let notNow = false


/** What the banner and the confirm say about the set: "may have", since older answers are judged by this Mac now. */
export function blindSummary(b: ReviewBlindAnswers): string {
  const n = b.thrownAway + b.kept
  return `${n} ${n === 1 ? 'answer' : 'answers'} may have been given without a picture (${b.thrownAway} thrown away, ${b.kept} kept).`
}

const PICTURE: Record<ReviewBlindItem['picture'], string> = { 'not-downloaded': 'not downloaded', missing: 'not found', none: 'no picture' }

/** One line of the confirm's list: file name, his answer, why there was no picture (when he answered, or now for an older answer). */
function BlindRow({ item }: { item: ReviewBlindItem }): JSX.Element {
  return (
    <li className="rv-blind-item">
      <span className="rv-blind-name" title={item.filename}>{item.filename}</span>
      <span className="rv-blind-answer">{item.answer === 'throwaway' ? 'thrown away' : 'kept'}</span>
      <span className="rv-blind-pic">{PICTURE[item.picture]} {item.recorded ? 'when you answered' : 'now'}</span>
    </li>
  )
}

/**
 * The line after a put-back: while the retrain it asked for runs, "Retraining…"; if that training did not finish,
 * why (the sorter's own words) and where to retrain. Once it has run the line goes and the strip shows its notice.
 */
export function blindDoneLine(n: number, failed: string | null): string {
  if (failed === null) return `Put back ${n}. Retraining…`
  return `Put back ${n}. Retraining did not finish: ${failed.replace(/[.\s]+$/, '')}. Retrain from Auto sorting.`
}

/** The confirm's words, from the counts main gave (exported for the UI test's expectations). */
export function blindConfirmLines(b: ReviewBlindAnswers): string[] {
  const lines = [`${b.thrownAway} thrown away and ${b.keptNotImported} kept go back to undecided.`]
  if (b.keptImported) lines.push(`${b.keptImported} kept ${b.keptImported === 1 ? 'one' : 'ones'} already imported stay${b.keptImported === 1 ? 's' : ''} kept.`)
  lines.push('No files are moved or deleted. The sorter then retrains.')
  if (b.emptied) lines.push(`${b.emptied} emptied from the Bin ${b.emptied === 1 ? 'stays' : 'stay'} emptied and ${b.emptied === 1 ? 'is' : 'are'} left alone.`)
  return lines
}

export function ReviewBlind({ refreshKey, onChanged }: { refreshKey: unknown; onChanged: () => void }): JSX.Element | null {
  const [found, setFound] = useState<ReviewBlindAnswers | null>(null)
  const [hidden, setHidden] = useState(notNow)
  const [confirm, setConfirm] = useState<ReviewBlindAnswers | null>(null)
  const [done, setDone] = useState<{ n: number; failed: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true // set again on every mount (StrictMode mounts twice)
    return () => void (mounted.current = false)
  }, [])

  const read = useCallback(async (): Promise<void> => {
    try {
      setFound(await window.sw.review.blindAnswers(BLIND_SINCE))
    } catch {
      setFound(null)
    }
  }, [])
  useEffect(() => {
    if (!hidden) void read()
  }, [refreshKey, hidden, read])

  // "Put back N. Retraining…" stays until the retrain that put-back asked for has ended (main holds its outcome from
  // the moment of the reset, so one that ended before this asks is answered at once): run, the line goes and the strip
  // shows its notice; did not finish, the line says why
  const followRetrain = async (n: number, id: number | undefined): Promise<void> => {
    if (id === undefined) return void setDone(null) // no retrain was asked for: nothing to wait on
    let end: Awaited<ReturnType<typeof window.sw.review.rescueRetrain>> = null
    try {
      end = await window.sw.review.rescueRetrain(id)
    } catch {
      end = null // not known: the strip still shows any retrain
    }
    if (!mounted.current) return
    setDone(end && !end.ok ? { n, failed: end.error ?? 'The sorter could not retrain just now.' } : null)
  }

  const putBack = async (): Promise<void> => {
    if (!confirm || sending.current) return
    sending.current = true
    const { token } = confirm
    setConfirm(null)
    try {
      const r = await window.sw.review.rescueBlind(token, BLIND_SINCE)
      if (r.ok) {
        setError(null)
        if (r.reset > 0) {
          setDone({ n: r.reset, failed: null })
          void followRetrain(r.reset, r.retrain)
        }
      } else setError(r.error ?? 'Something changed since you looked; check the list again.') // the banner reads the list again below
    } catch {
      setError('That did not go through; nothing was put back.')
    } finally {
      sending.current = false
      onChanged()
      await read()
    }
  }

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setConfirm(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [confirm])

  if (done) {
    return (
      <div className="rv-blind" role="status" data-testid="blind-done" data-failed={done.failed === null ? undefined : 'true'}>
        {blindDoneLine(done.n, done.failed)}
      </div>
    )
  }
  if (hidden || !found) return null
  const resettable = found.thrownAway + found.keptNotImported
  if (resettable === 0) return null
  return (
    <>
      <div className="rv-blind" role="status" data-testid="blind-banner">
        <span className="rv-blind-text">
          {blindSummary(found)} Put them back to undecided and retrain?
          {error && <span className="rv-blind-err"> {error}</span>}
        </span>
        <span className="rv-blind-acts">
          <button className="ts-btn rv-blind-go" onClick={() => setConfirm(found)}>Put them back…</button>
          <button className="ts-link rv-blind-later" onClick={() => { notNow = true; setHidden(true) }}>Not now</button>
        </span>
      </div>
      {confirm && (
        <div className="overlay rv-blind-overlay" onClick={() => setConfirm(null)}>
          <div className="rv-confirm" role="dialog" aria-label="Put answers back to undecided" onClick={(e) => e.stopPropagation()}>
            <h3>Put {confirm.thrownAway + confirm.keptNotImported} {confirm.thrownAway + confirm.keptNotImported === 1 ? 'answer' : 'answers'} back to undecided?</h3>
            <p>{blindSummary(confirm)}</p>
            {blindConfirmLines(confirm).map((l) => <p key={l}>{l}</p>)}
            {/* every one that goes back, from the same read as the counts and the token */}
            <ul className="rv-blind-list" aria-label="Answers put back" data-testid="blind-list">
              {confirm.items.filter((i) => i.putBack).map((i) => <BlindRow key={i.hash} item={i} />)}
            </ul>
            <div className="rv-confirm-btns">
              <button className="rv-cancel" autoFocus onClick={() => setConfirm(null)}>Cancel</button>
              <button className="rv-danger rv-blind-confirm" onClick={() => void putBack()}>Put back {confirm.thrownAway + confirm.keptNotImported}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
