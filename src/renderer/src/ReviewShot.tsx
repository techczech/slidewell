// The picture on a Review card, or a quiet placeholder window when there is none (not downloaded, or the preview).
import { useState } from 'react'
import type { ReviewCard } from '../../preload'

function tone(hash: string): string {
  let h = 0
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0
  return `g${(h % 6) + 1}`
}

/**
 * The picture, or a quiet placeholder window when there is none (not downloaded, or the preview) or it would not load.
 * A failed load is remembered for that picture only: the large card reuses one Shot for every card in turn, so a
 * plain "failed" flag would leave every later card on the placeholder too.
 */
export function Shot({ card, caption, className = '' }: { card: ReviewCard; caption?: string; className?: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const failed = card.thumbUrl !== null && failedUrl === card.thumbUrl
  const dark = card.app === 'Terminal'
  return (
    <div className={`rv-shot ${dark ? 't2' : tone(card.hash)} ${className}`}>
      {card.thumbUrl && !failed ? (
        <img key={card.thumbUrl} src={card.thumbUrl} alt="" loading="lazy" onError={() => setFailedUrl(card.thumbUrl)} />
      ) : (
        <div className={`rv-win ${dark ? 't2' : tone(card.hash + 'w')}`} />
      )}
      {card.offline && <span className="rv-what">not downloaded</span>}
      {!card.offline && caption && <span className="rv-what">{caption}</span>}
    </div>
  )
}
