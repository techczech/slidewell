// "See what moved" (frame B2, ticket 23): Review narrowed to the screenshots the last retrain moved to sure,
// with a way back. Main gives the hashes (up to 200); there is no read by hash, so this pages through the Kept and
// Throwaway piles until every hash is found or both piles end. Read-only: nothing here decides anything.
import { useEffect, useState } from 'react'
import type { ReviewCard } from '../../preload'
import { Shot } from './ReviewShot'

async function findCards(hashes: string[]): Promise<ReviewCard[]> {
  const want = new Set(hashes)
  const found = new Map<string, ReviewCard>()
  for (const pile of ['kept', 'throwaway'] as const) {
    let cursor: string | null = null
    do {
      const pg: { items: ReviewCard[]; next: string | null } = await window.sw.review.page(pile, cursor, 500)
      for (const c of pg.items) if (want.has(c.hash)) found.set(c.hash, c)
      cursor = found.size >= want.size ? null : pg.next
    } while (cursor)
    if (found.size >= want.size) break
  }
  return hashes.map((h) => found.get(h)).filter((c): c is ReviewCard => Boolean(c))
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
