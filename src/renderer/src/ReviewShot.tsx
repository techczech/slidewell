// The picture on a Review card. When there is none, a flat labelled panel that cannot be mistaken for a screenshot.
import { useState } from 'react'
import type { ReviewCard } from '../../preload'

/** A path for display: the home folder shown as ~ (the path itself is never changed). */
export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~')
}

/** Picture URLs that failed to load in this window (any Shot): a card whose picture would not load was shown as missing. */
const failedUrls = new Set<string>()
/** Picture URLs that finished loading in this window (any Shot): only these count as a picture he saw. */
const loadedUrls = new Set<string>()

/** An image for `url` loaded (Shot's onLoad). */
export function noteLoaded(url: string): void {
  loadedUrls.add(url)
  failedUrls.delete(url)
}
/** An image for `url` would not load (Shot's onError). */
export function noteFailed(url: string): void {
  failedUrls.add(url)
  loadedUrls.delete(url)
}

/**
 * The picture state the card is shown with, sent with his answer (review.act) so main records what he actually saw
 * rather than its own file check. 'ok' only once the image for that URL has loaded: one still loading (or never
 * scrolled into view) was not seen and counts as 'none'; one that would not load shows the missing panel.
 */
export function shownPicture(card: ReviewCard): ReviewCard['picture'] {
  if (card.thumbUrl && loadedUrls.has(card.thumbUrl)) return 'ok'
  if (card.thumbUrl && failedUrls.has(card.thumbUrl)) return 'missing'
  if (card.thumbUrl) return 'none'
  return card.picture === 'ok' ? 'none' : card.picture
}

const BIG = { 'not-downloaded': 'Not downloaded on this Mac', missing: 'File not found', none: 'No picture' } as const
const SMALL = { 'not-downloaded': 'Not downloaded', missing: 'Not found', none: 'No picture' } as const

/**
 * The picture, or a plain panel saying why there is none. A failed load is remembered for that picture only: the
 * large card reuses one Shot for every card in turn, so a plain "failed" flag would leave every later card on the
 * panel too. A picture that will not load counts as missing.
 */
export function Shot({ card, caption, className = '' }: { card: ReviewCard; caption?: string; className?: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const failed = card.thumbUrl !== null && (failedUrl === card.thumbUrl || failedUrls.has(card.thumbUrl))
  const state = card.thumbUrl && !failed ? 'ok' : failed ? 'missing' : card.picture === 'ok' ? 'none' : card.picture
  const big = className.includes('rv-big-shot') || className.includes('tr-shot')
  return (
    <div className={`rv-shot ${state === 'ok' ? '' : 'rv-nopic'} ${className}`} data-picture={state}>
      {state === 'ok' ? (
        <img key={card.thumbUrl ?? ''} src={card.thumbUrl ?? ''} alt="" loading="lazy"
          onLoad={() => {
            if (card.thumbUrl) noteLoaded(card.thumbUrl)
          }}
          onError={() => {
            if (card.thumbUrl) noteFailed(card.thumbUrl)
            setFailedUrl(card.thumbUrl)
          }} />
      ) : (
        <div className="rv-nopic-text">
          <span className="rv-nopic-main">{big ? BIG[state] : SMALL[state]}</span>
          {big && state === 'not-downloaded' && (
            <>
              <span className="rv-nopic-sub">It is in your cloud folder; open it in Finder to download it.</span>
              {card.revealUrl && (
                <button className="rv-nopic-btn" onClick={() => void window.sw.archive.reveal(card.revealUrl)}>
                  Open in Finder
                </button>
              )}
            </>
          )}
          {big && state === 'missing' && card.expectedDir && <span className="rv-nopic-sub">Expected in {shortPath(card.expectedDir)}</span>}
        </div>
      )}
      {state === 'ok' && caption && <span className="rv-what">{caption}</span>}
    </div>
  )
}
