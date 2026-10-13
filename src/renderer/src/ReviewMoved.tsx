// "See what moved" (frame B2, ticket 23): Review narrowed to the screenshots the last retrain moved to sure,
// with a way back. Main gives the hashes (up to 200) and their cards in one read by hash (review.cards), which leaves
// out anything in the Bin or gone. One that is no longer sure (sorted again since, back in Need a look) is not shown.
// Read-only: nothing here decides anything.
import { useEffect, useState } from 'react'
import type { ReviewCard } from '../../preload'
import { Shot } from './ReviewShot'

async function findCards(hashes: string[]): Promise<ReviewCard[]> {
  const cards = await window.sw.review.cards(hashes.slice(0, 200))
  return cards.filter((c) => c.pile === 'kept' || c.pile === 'throwaway')
}

export function ReviewMoved({ hashes, onBack }: { hashes: string[]; onBack: () => void }): JSX.Element {
  const [cards, setCards] = useState<ReviewCard[] | null>(null)
  useEffect(() => {
    let live = true
    void findCards(hashes).then((c) => live && setCards(c))
    return () => {
      live = false
    }
  }, [hashes])
  const keep = cards?.filter((c) => c.pile === 'kept').length ?? 0
  return (
    <div className="rv-screen" data-mode="moved">
      <div className="rv-head mv-head">
        <h1>What moved</h1>
        <span className="rv-sub">
          {cards ? `${cards.length} screenshots the last retrain moved to sure · ${keep} keep, ${cards.length - keep} throwaway` : 'finding them…'}
        </span>
        <button className="rv-back-btn" onClick={onBack}>‹ Back to review</button>
      </div>
      <div className="rv-pl-main">
        <section className="rv-pl-left" style={{ width: '100%' }} aria-label="Screenshots that moved">
          <div className="rv-pgrid">
            {(cards ?? []).map((c) => (
              <div key={c.hash} className="rv-pc" data-hash={c.hash}>
                <Shot card={c} />
                <div className="rv-m" title={c.reason}>
                  <b>{c.app || c.filename}</b>
                  <span>{c.windowTitle || (c.app ? c.filename : '')}</span>
                  <span className={c.pile === 'kept' ? 'rv-lbl keep' : 'rv-lbl toss'}>{c.pile === 'kept' ? 'now keep' : 'now throwaway'}</span>
                </div>
              </div>
            ))}
          </div>
          {cards && cards.length === 0 && <div className="rv-quiet">None of them are left to show. You may have decided them since.</div>}
        </section>
      </div>
    </div>
  )
}
