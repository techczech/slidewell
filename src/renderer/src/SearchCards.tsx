import type { DeckCard, SlideClusterResult } from '../../preload'

// The displayed author/owner of a result. In the Others' Library it's the deck's author (else
// "unknown"); in your own archive it's "me" by default, unless a deck is detected as someone else's.
export const authorOf = (h: { library?: 'mine' | 'others'; ownership?: string; author?: string }): string =>
  h.library === 'others' ? h.author?.trim() || 'unknown' : h.ownership === 'others' && h.author?.trim() ? h.author.trim() : 'me'

export function talksLine(n: number): string {
  return `used in ${n} talk${n === 1 ? '' : 's'}`
}

function clusterBadge(c: SlideClusterResult): string {
  if (c.size > 1 && c.lookAlike) return `▸ ${c.size} versions`
  if (c.size > 1) return `▸ ${c.size} near-identical in ${c.deckCount} presentation${c.deckCount === 1 ? '' : 's'}`
  if (c.representative.usedInDecks > 1) return `used in ${c.representative.usedInDecks} presentations`
  return ''
}

export function Card({
  cluster,
  selected,
  onSelect,
  onThumb,
  onMenu,
  onExpand
}: {
  cluster: SlideClusterResult
  selected: boolean
  onSelect: () => void
  onThumb: () => void
  onMenu: (x: number, y: number) => void
  onExpand: () => void
}): JSX.Element {
  const h = cluster.representative
  const isWell = h.kind === 'well-image'
  const isImg = h.kind === 'archive-image'
  const ocr = h.kind === 'ocr-render' || h.kind === 'ocr-image'
  const badge = clusterBadge(cluster)
  const who = authorOf(h)
  const foot = [h.filename || h.deck, h.slideOrder !== null ? `#${h.slideOrder}` : '', h.date ? h.date.slice(0, 10) : '', h.category, who !== 'me' ? `by ${who}` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={selected ? 'card selected' : 'card'}
      onClick={onSelect}
      onDoubleClick={onThumb}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="thumb-wrap" title="Click to select · double-click to open">
        {h.thumbUrl ? (
          <img className="thumb" src={h.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {isWell ? (
          <span className="ocr-tag well">WELL</span>
        ) : isImg ? (
          <span className="ocr-tag img">IMG</span>
        ) : ocr ? (
          <span className="ocr-tag">OCR</span>
        ) : null}
        {h.score && <span className={`score-chip ${h.score.kind}`} title={h.score.kind === 'words' ? 'How well the words match, 0 to 1' : 'How closely the picture matches, 0 to 1'}>{h.score.label}</span>}
        {h.library === 'others' && <span className="ocr-tag others" title="From your Others' Library — not your own presentation">OTHERS</span>}
        <button
          className="more"
          title="Actions"
          onClick={(e) => { e.stopPropagation(); onMenu(e.clientX, e.clientY) }}
        >⋯</button>
      </div>
      <div className="meta">
        <div className="card-title" title={h.title}>{h.title}</div>
        {h.snippet && <div className="snippet">{ocr ? '[OCR] ' : ''}{h.snippet}</div>}
        <div className="card-foot">
          <span className="deck" title={foot}>{foot}</span>
          {badge && (
            <span className={cluster.size > 1 ? 'badge clickable' : 'badge'} onClick={cluster.size > 1 ? onExpand : undefined}>
              {badge}
            </span>
          )}
          {(h.usedInTalks ?? 0) > 0 && <span className="badge talks">{talksLine(h.usedInTalks ?? 0)}</span>}
        </div>
      </div>
    </div>
  )
}

export function DeckCardView({ deck, selected, onSelect }: { deck: DeckCard; selected: boolean; onSelect: () => void }): JSX.Element {
  return (
    <div className={selected ? 'card deck-card selected' : 'card deck-card'} onClick={onSelect} title={deck.title}>
      <div className="thumb-wrap">
        {deck.coverThumbUrl ? (
          <img className="thumb" src={deck.coverThumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="thumb placeholder" />
        )}
        <span className="slide-num">{deck.slideCount} slides</span>
        {deck.library === 'others' && <span className="ocr-tag others" title="From your Others' Library">OTHERS</span>}
      </div>
      <div className="meta">
        <div className="card-title" title={deck.title}>{deck.title}</div>
        <div className="card-foot">
          <span className="deck">{[deck.date ? deck.date.slice(0, 10) : '', deck.category, authorOf(deck) !== 'me' ? `by ${authorOf(deck)}` : ''].filter(Boolean).join(' · ') || deck.filename}</span>
        </div>
      </div>
    </div>
  )
}
