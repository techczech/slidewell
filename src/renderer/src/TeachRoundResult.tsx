// The result of a round of ten (frame A2): what the retrain moved, in plain figures. When the sorter could not check
// what moved (needALook / movedToSure null) it says it retrained and gives the accuracy figures only. The frame's
// sentence about targeted answers helping more is left out: only figures are shown.
import type { SorterRetrain, SorterStatus } from '../../preload'
import { n } from './sorter-format'
import { roundRetrainLine, shareChange, wholePct } from './teach-format'

export type RoundOutcome =
  | { kind: 'retrained'; retrain: SorterRetrain; status: SorterStatus; kept: number; thrown: number }
  | { kind: 'none-answered' }
  | { kind: 'needs-more'; answered: number; need: number }
  | { kind: 'failed'; answered: number; message: string }

type Props = { outcome: RoundOutcome; waiting: number; onAnother: () => void; onDone: () => void; onSeeMoved: (hashes: string[]) => void }

function Buttons({ waiting, onAnother, onDone, onSeeMoved, moved }: Omit<Props, 'outcome'> & { moved: string[] }): JSX.Element {
  const next = Math.min(10, waiting)
  return (
    <>
      <div className="tr-actions">
        <button className="tr-pri" disabled={waiting === 0} onClick={onAnother}>Another 10 <kbd>Return</kbd></button>
        <button className="tr-sec" onClick={onDone}>Done <kbd>Esc</kbd></button>
        {moved.length > 0 && <button className="tr-link" onClick={() => onSeeMoved(moved)}>See what moved</button>}
      </div>
      <p className="tr-fine">
        {waiting === 0
          ? 'Nothing is left that it is unsure about.'
          : `Next ten would be the ${next} least certain of the ${n(waiting)} still waiting.`}
      </p>
    </>
  )
}

export function TeachRoundResult(props: Props): JSX.Element {
  const o = props.outcome
  if (o.kind !== 'retrained') {
    const msg =
      o.kind === 'none-answered'
        ? { h: 'You did not answer any.', p: 'Nothing was answered, so the sorter did not retrain.' }
        : o.kind === 'needs-more'
          ? { h: `You answered ${n(o.answered)}.`, p: `Each answer is saved. The sorter needs ${n(o.need)} more ${o.need === 1 ? 'choice' : 'choices'} before it can retrain.` }
          : { h: `You answered ${n(o.answered)}.`, p: `Each answer is saved, but the sorter did not retrain. ${o.message}` }
    return (
      <div className="tr-result" data-testid="round-result" data-kind={o.kind}>
        <div className="tr-result-main">
          <div className="tr-rl">Teaching round finished</div>
          <h1>{msg.h}</h1>
          <p className="tr-lede">{msg.p}</p>
          <Buttons {...props} moved={[]} />
        </div>
      </div>
    )
  }
  const { retrain: r, status: st, kept, thrown } = o
  const moved = r.movedToSure
  const movedN = moved ? moved.keep + moved.throwaway : 0
  const t = shareChange(r.accuracy.before?.throwawayRight, r.accuracy.after.throwawayRight)
  const k = shareChange(r.accuracy.before?.keepRight, r.accuracy.after.keepRight)
  const choiceKept = st.learnable?.kept ?? 0
  const choiceThrown = st.learnable?.binned ?? 0
  const choiceTotal = choiceKept + choiceThrown
  const nl = r.needALook
  return (
    <div className="tr-result" data-testid="round-result" data-kind="retrained">
      <div className="tr-result-main">
        <div className="tr-rl">Teaching round finished</div>
        <h1>You answered {n(kept + thrown)}.<br />The sorter retrained.</h1>
        <p className="tr-lede">{roundRetrainLine(r.choices.after, kept, thrown)}</p>
        <div className="tr-stats">
          {nl && moved && (
            <div className="tr-stat" data-testid="round-moved">
              <div className="tr-big-n">{n(movedN)}</div>
              <div className="tr-sl">{movedN === 1 ? 'screenshot moved' : 'screenshots moved'} from needs-a-look to sure</div>
              <div className="tr-ss">{n(moved.keep)} keep, {n(moved.throwaway)} throwaway</div>
              <div className="tr-bl">Needs a look</div>
              <div className="tr-bar"><div className="a" style={{ width: `${nl.before > 0 ? Math.min(100, (nl.after / nl.before) * 100) : 0}%` }} /></div>
              <div className="tr-barlab"><span>Now {n(nl.after)}</span><span>was {n(nl.before)}</span></div>
            </div>
          )}
          {t !== null && (
            <div className="tr-stat" data-testid="round-accuracy">
              <div className="tr-big-n">{t}</div>
              <div className="tr-sl">Throwaway right, on the held-back sample</div>
              {k && <div className="tr-ss">Keep right: {k}</div>}
              {r.accuracy.before?.throwawayRight != null && (
                <div className="tr-ba">
                  <div><span>Before</span><div className="tr-bar slim"><div className="t" style={{ width: `${wholePct(r.accuracy.before.throwawayRight)}%` }} /></div></div>
                  <div><span>Now</span><div className="tr-bar slim"><div className="k" style={{ width: `${wholePct(r.accuracy.after.throwawayRight ?? 0)}%` }} /></div></div>
                </div>
              )}
            </div>
          )}
        </div>
        <Buttons {...props} moved={r.movedHashes} />
      </div>
      <aside className="tr-side tr-result-side">
        <h3>Choices so far</h3>
        <div className="tr-card2">
          <div className="tr-choices-n">{n(choiceTotal || r.choices.after)}</div>
          <div className="rv-cbar"><div className="k" style={{ width: `${choiceTotal ? (choiceKept / choiceTotal) * 100 : 0}%` }} /><div className="t" style={{ width: `${choiceTotal ? (choiceThrown / choiceTotal) * 100 : 0}%` }} /></div>
          <div className="rv-cbar-lab"><span><b>{n(choiceKept)}</b> kept</span><span><b>{n(choiceThrown)}</b> thrown away</span></div>
        </div>
      </aside>
    </div>
  )
}
