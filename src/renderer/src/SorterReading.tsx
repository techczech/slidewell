// The reading of "how much is enough" (ticket 23): the verdict sentence, the two-panel chart with the minimum marked,
// the kept / thrown-away balance and the "Teach the sorter (10)" button. One component, two homes: the popover from
// Review's strip (frame B3) and Triage › Auto sorting › Training (frame A3's content). Main works the reading out
// once per training and can take ~20 s the first time, so a quiet "working it out" line shows meanwhile and the
// rest (balance, button) is already usable.
import type { ReactNode } from 'react'
import { LearningChart } from './LearningChart'
import { useLearning, useSorterStatus } from './sorter-hooks'
import { n } from './sorter-format'
import { balanceNote, choicesOf, gainsLine, readingWords } from './teach-format'
import { startTeachingRound } from './teach-round'
import './teach.css'

/** `untrained`: the sorter has no current model (changed since it last learnt, or never trained). The reading is the last one and says so. In the tab it is
 *  shown only when there are points and without the balance bar (the Training card above already shows it); the Teach button stays, since the round explains. */
export function SorterReading({ variant, children, untrained }: { variant: 'popover' | 'tab'; children?: ReactNode; untrained?: 'again' | 'never' }): JSX.Element | null {
  const st = useSorterStatus()
  const { learning, working, failed } = useLearning(`${st?.report?.trainedAt ?? ''}|${st?.lastRetrain?.at ?? ''}`)
  if (!st) return null
  const kept = learning?.kept ?? st.learnable?.kept ?? 0
  const thrown = learning?.thrownAway ?? st.learnable?.binned ?? 0
  const choices = choicesOf(st) || (learning?.choices ?? 0)
  const words = learning ? readingWords(learning, choices) : { headline: `${n(choices)} ${choices === 1 ? 'choice' : 'choices'} so far.`, sub: '' }
  const gains = learning ? gainsLine(learning.points) : null
  const total = kept + thrown
  const inCard = untrained !== undefined && variant === 'tab'
  if (inCard && !(learning && learning.points.length > 0)) return null
  const H = variant === 'popover' ? 'h2' : 'h3'
  return (
    <div className={`sr-reading sr-${variant}`} data-testid="sorter-reading" data-verdict={learning?.verdict ?? 'pending'}>
      {variant === 'popover' && <div className="sr-label">Sorter training</div>}
      {untrained === 'again' && <p className="sr-from-last">From the last training, before the sorter changed.</p>}
      <H className="sr-headline">{words.headline}</H>
      {words.sub && <p className="sr-sub">{words.sub}</p>}
      {working && (
        <p className="sr-working" role="status">
          Working out how much is enough… this can take a little while the first time after a training. Nothing here has to wait for it.
        </p>
      )}
      {failed && !working && <p className="sr-working">The reading could not be worked out just now.</p>}
      {learning && learning.points.length > 0 && <LearningChart learning={learning} />}
      {gains && <p className="sr-gains">{gains}</p>}
      {!inCard && (
      <div className="sr-balance">
        <div className="sr-bal-bar">
          <div className="as-bar" role="img" aria-label={`${n(kept)} kept, ${n(thrown)} thrown away`}>
            <div className="as-bar-k" style={{ width: `${total ? (kept / total) * 100 : 0}%` }} />
            <div className="as-bar-t" style={{ width: `${total ? (thrown / total) * 100 : 0}%` }} />
          </div>
          <div className="as-barlab">
            <span><b>{n(kept)}</b> kept</span>
            <span><b>{n(thrown)}</b> thrown away</span>
          </div>
        </div>
        <p className="sr-bal-note">{balanceNote(kept, thrown)}</p>
      </div>
      )}
      <div className="sr-actions">
        <button className="pic-primary sr-teach" onClick={() => startTeachingRound()}>
          Teach the sorter (10)
        </button>
        {children}
      </div>
    </div>
  )
}
