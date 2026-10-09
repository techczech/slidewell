// Settings › Screenshot sorter: train on his past keep/bin choices, show the held-back accuracy
// report, and sort undecided screenshots. The main process owns all of it (src/main/sorter/); this
// file shows state and sends the two commands. Sorting records proposals only.
import { useCallback, useEffect, useState } from 'react'
import type { SorterAccuracy, SorterStatus } from '../../preload'

function useSorterStatus(): SorterStatus | null {
  const [st, setSt] = useState<SorterStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.sorter.status().then((s) => live && setSt(s))
    const off = window.sw.sorter.onStatus((s) => setSt(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return st
}

const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`)
const n = (x: number): string => x.toLocaleString('en-GB')
const day = (iso: string): string => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function AccuracyRows({ a, label }: { a: SorterAccuracy; label: string }): JSX.Element {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {pct(a.keep.precision)} <span className="sorter-count">{a.keep.proposed ? `${a.keep.correct} of ${a.keep.proposed}` : 'none proposed'}</span>
      </td>
      <td>
        {pct(a.throwaway.precision)} <span className="sorter-count">{a.throwaway.proposed ? `${a.throwaway.correct} of ${a.throwaway.proposed}` : 'none proposed'}</span>
      </td>
      <td>
        {pct(a.doubtful.share)} <span className="sorter-count">{`${a.doubtful.count} of ${a.sample}`}</span>
      </td>
    </tr>
  )
}

export function SorterSettings(): JSX.Element {
  const st = useSorterStatus()
  const [result, setResult] = useState<string | null>(null)

  const trainNow = useCallback(async () => {
    setResult(null)
    const r = await window.sw.sorter.train()
    if (!r.ok && r.error) setResult(r.error) // on success the pushed status carries the new report
  }, [])
  const sortNow = useCallback(async () => {
    setResult(null)
    const r = await window.sw.sorter.sort()
    setResult(r.ok && r.counts ? `Sorted ${n(r.sorted ?? 0)}: ${n(r.counts.keep)} keep, ${n(r.counts.throwaway)} throwaway, ${n(r.counts.doubtful)} need a look.` : (r.error ?? null))
  }, [])

  if (!st) return <div className="pic-settings sorter-settings" />
  const running = st.phase === 'embedding' || st.phase === 'training' || st.phase === 'sorting'
  const rep = st.report
  const a = rep?.heldBack

  return (
    <div className="pic-settings sorter-settings" data-phase={st.phase}>
      <h3 className="pic-title">Screenshot sorter</h3>
      <p>Proposes keep, throwaway or “needs a look” for screenshots you have not decided yet. It learns from what you kept and binned before. When unsure, it asks you: nothing is proposed as throwaway unless it is sure.</p>
      <p>It only records proposals; it never moves or deletes a file, and it runs on this Mac.</p>

      {a && rep ? (
        <div className="sorter-report">
          <div className="sorter-report-head">
            Tested on {n(a.sample)} of your past choices it had not seen ({n(a.truth.keep)} kept, {n(a.truth.throwaway)} binned) · {day(rep.trainedAt)}
          </div>
          <table className="sorter-table">
            <thead>
              <tr>
                <th />
                <th>Keep right</th>
                <th>Throwaway right</th>
                <th>Need a look</th>
              </tr>
            </thead>
            <tbody>
              <AccuracyRows a={a} label="Sorter" />
              <AccuracyRows a={rep.rulesOnly} label="Rules alone" />
            </tbody>
          </table>
          <div className="pic-note">
            {a.keptProposedThrowaway === 0 ? 'No screenshot you kept was proposed as throwaway.' : `${n(a.keptProposedThrowaway)} screenshot${a.keptProposedThrowaway === 1 ? '' : 's'} you kept would have been proposed as throwaway.`} Throwaway needs {pct(rep.thresholds.throwaway)} certainty; keep needs {pct(rep.thresholds.keep)}.
            {rep.calibration ? ` Certainty is calibrated on your past choices (${rep.calibration.chosen === 'platt' ? 'Platt scaling' : 'isotonic regression'}).` : ''}
          </div>
        </div>
      ) : (
        <div className="pic-note">Not trained yet. Training reads your past choices, holds back a fifth of them, and tests itself on those before it sorts anything.</div>
      )}

      <div className="pic-actions">
        {!running && (
          <>
            <button className="pic-primary" disabled={!st.modelReady} onClick={() => void trainNow()}>
              {rep ? 'Train again and test' : 'Train on my past choices and test'}
            </button>
            <button className="copyref" disabled={!st.modelReady || !st.canRunUnattended} onClick={() => void sortNow()}>
              Sort undecided screenshots now
            </button>
          </>
        )}
        {running && (
          <>
            {st.total > 0 ? <progress className="pic-progress" value={st.done} max={st.total} /> : <progress className="pic-progress" />}
            <span className="pic-progress-text">
              {st.message[0]?.toUpperCase()}
              {st.message.slice(1)}
              {st.total > 0 ? ` · ${n(st.done)} of ${n(st.total)}` : ''}
            </span>
            <button className="copyref" onClick={() => void window.sw.sorter.cancel()}>
              Stop
            </button>
          </>
        )}
      </div>
      {!st.modelReady && <div className="pic-note">Needs the picture search model (above).</div>}
      {st.error && <p className="pic-error">The sorter stopped: {st.error}</p>}
      {result && <div className="pic-note sorter-result">{result}</div>}
      {st.pending.lastProposedAt && (
        <div className="pic-note">
          Waiting for you: {n(st.pending.keep)} proposed keep, {n(st.pending.throwaway)} proposed throwaway, {n(st.pending.doubtful)} need a look · sorted {day(st.pending.lastProposedAt)}
        </div>
      )}
    </div>
  )
}
