import { useEffect, useState } from 'react'
import type { DeckCard, DeckDetail, MoreLikeThisResult, SlideClusterResult, SlideResult } from '../../preload'
import { authorOf, talksLine } from './SearchCards'

export function DeckSidebar({
  detail,
  onClose,
  onSeeAll,
  onReveal
}: {
  detail: DeckDetail & { coverThumbUrl: string | null }
  onClose: () => void
  onSeeAll: () => void
  onReveal: () => void
}): JSX.Element {
  const rows: [string, string][] = [
    ['Date', detail.date ? `${detail.date.slice(0, 10)} (${detail.dateSource})` : '—'],
    ['Folder', detail.category || '—'],
    ['File', detail.filename || '—'],
    ['Slides', String(detail.slideCount)],
    ['Sections', String(detail.sectionCount)],
    ['Owner', detail.ownership],
    ['Author', authorOf({ library: detail.library, ownership: detail.ownership, author: detail.author })],
    ['Source', detail.sourcePath || '—']
  ]
  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-head">
        <b>{detail.title}</b>
        <button className="copyref" onClick={onClose}>✕</button>
      </div>
      {detail.coverThumbUrl && <img className="deck-sidebar-cover" src={detail.coverThumbUrl} alt="" />}
      <div className="details-table">
        {rows.map(([k, v]) => (
          <div className="drow" key={k}>
            <span className="dk">{k}</span>
            <span className="dv">{v}</span>
          </div>
        ))}
      </div>
      <div className="details-actions">
        <button className="primary-btn" onClick={onSeeAll}>See all slides</button>
        <button className="copyref" onClick={onReveal}>Reveal in Finder</button>
      </div>
    </aside>
  )
}

export type ActionId = 'fullsize' | 'copy-image' | 'copy-image-png' | 'copy-text' | 'copy-structure' | 'copy-ref' | 'reveal' | 'expand' | 'details' | 'context'

export function ContextMenu({
  cluster,
  x,
  y,
  onClose,
  onAction
}: {
  cluster: SlideClusterResult
  x: number
  y: number
  onClose: () => void
  onAction: (a: ActionId) => void
}): JSX.Element {
  const k = cluster.representative.kind
  const isImage = k === 'well-image' || k === 'archive-image'
  const items: { id: ActionId; label: string }[] = [
    { id: 'fullsize', label: 'Open full size' },
    { id: 'copy-image', label: 'Copy image (WebP → TalkWeaver)' },
    { id: 'copy-image-png', label: 'Copy as PNG' },
    { id: 'copy-text', label: 'Copy text' },
    ...(isImage ? [] : [{ id: 'copy-structure' as ActionId, label: 'Copy structure (JSON)' }]),
    { id: 'copy-ref', label: 'Copy reference' },
    { id: 'reveal', label: 'Reveal in Finder' },
    ...(cluster.size > 1 ? [{ id: 'expand' as ActionId, label: `Expand cluster (${cluster.size})` }] : []),
    ...(k === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole presentation)' }]),
    { id: 'details', label: 'Show details' }
  ]
  // keep the menu on-screen
  const left = Math.min(x, window.innerWidth - 220)
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16)
  return (
    <>
      <div className="menu-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="ctx-menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        {items.map((it) => (
          <button key={it.id} className="ctx-item" onClick={() => onAction(it.id)}>{it.label}</button>
        ))}
      </div>
    </>
  )
}

export function Lightbox({
  hit,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onCopyRef
}: {
  hit: SlideResult
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onCopyRef: (h: SlideResult) => void
}): JSX.Element {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lb-stage">
          {total > 1 && <button className="lb-nav left" onClick={onPrev} disabled={index === 0}>‹</button>}
          {hit.thumbUrl ? <img className="lb-img" src={hit.thumbUrl} alt={hit.title} /> : <div className="lb-img placeholder">no render</div>}
          {total > 1 && <button className="lb-nav right" onClick={onNext} disabled={index === total - 1}>›</button>}
        </div>
        <div className="lb-bar">
          <div className="lb-title">{hit.title}</div>
          <div className="lb-meta">{[hit.deckTitle, hit.slideOrder !== null ? `slide ${hit.slideOrder + 1}` : '', total > 1 ? `${index + 1}/${total}` : ''].filter(Boolean).join(' · ')}</div>
          <button className="copyref" onClick={() => onCopyRef(hit)}>copy ref</button>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
      </div>
    </div>
  )
}

export function ClusterModal({
  cluster,
  onClose,
  onOpen
}: {
  cluster: SlideClusterResult
  onClose: () => void
  onOpen: (index: number) => void
}): JSX.Element {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{cluster.size} {cluster.lookAlike ? 'versions' : 'near-identical slides'}</b>{cluster.lookAlike ? (cluster.lookAlike === 'same-picture' ? ' of the same picture' : ' of the same thing, changed') : ''}{cluster.members.some((m) => m.kind !== 'well-image') && <> across {cluster.deckCount} presentation{cluster.deckCount === 1 ? '' : 's'}</>}
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <div className="grid">
          {cluster.members.map((m, i) => (
            <div className="card" key={`${m.deck}-${m.slideOrder}-${i}`}>
              <div className="thumb-wrap" onClick={() => onOpen(i)} title="Open full size">
                {m.thumbUrl ? <img className="thumb" src={m.thumbUrl} alt="" loading="lazy" /> : <div className="thumb placeholder" />}
              </div>
              <div className="meta">
                <div className="card-foot"><span className="deck">{m.filename || m.deck}{m.slideOrder !== null ? ` · #${m.slideOrder}` : ''}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DetailsModal({
  hit,
  onClose,
  onCopyText,
  onCopyRef,
  onCopyStructure
}: {
  hit: SlideResult
  onClose: () => void
  onCopyText: () => void
  onCopyRef: () => void
  onCopyStructure: () => void
}): JSX.Element {
  const rows: [string, string][] = [
    ['Presentation', hit.deckTitle || hit.deck],
    ['File', hit.filename],
    ['Slide', hit.slideOrder !== null ? String(hit.slideOrder + 1) : '—'],
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Used in', `${hit.usedInDecks} presentation${hit.usedInDecks === 1 ? '' : 's'}`],
    ['Matched', hit.kind === 'slide' ? 'slide body' : 'image text (OCR)'],
    ['Reference', hit.reference]
  ]
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{hit.title}</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <div className="details-body">
          {hit.thumbUrl && <img className="details-img" src={hit.thumbUrl} alt={hit.title} />}
          <div className="details-table">
            {rows.map(([k, v]) => (
              <div className="drow" key={k}><span className="dk">{k}</span><span className="dv">{v}</span></div>
            ))}
            {hit.text && <div className="details-text">{hit.text}</div>}
            <div className="details-actions">
              <button className="copyref" onClick={onCopyText}>copy text</button>
              <button className="copyref" onClick={onCopyStructure}>copy structure</button>
              <button className="copyref" onClick={onCopyRef}>copy ref</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function actionItems(deckMode: boolean, kind?: string): { id: ActionId; label: string; shortcut?: string }[] {
  if (deckMode)
    return [
      { id: 'fullsize', label: 'See all slides in this presentation', shortcut: '↵' },
      { id: 'details', label: 'Show metadata (inspector)', shortcut: 'I' },
      { id: 'reveal', label: 'Reveal in Finder', shortcut: 'F' }
    ]
  const isImage = kind === 'well-image' || kind === 'archive-image'
  return [
    { id: 'fullsize', label: 'Open full size', shortcut: '↵' },
    { id: 'details', label: 'Show metadata (inspector)', shortcut: 'I' },
    { id: 'copy-image', label: 'Copy image (WebP → TalkWeaver)', shortcut: '⌘C' },
    { id: 'copy-image-png', label: 'Copy as PNG', shortcut: '⌘⇧C' },
    { id: 'copy-text', label: 'Copy text', shortcut: 'T' },
    ...(isImage ? [] : [{ id: 'copy-structure' as ActionId, label: 'Copy structure (JSON)', shortcut: 'J' }]),
    { id: 'copy-ref', label: 'Copy reference', shortcut: 'R' },
    { id: 'reveal', label: 'Reveal in Finder', shortcut: 'F' },
    ...(kind === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole presentation)', shortcut: 'X' }])
  ]
}

function MoreLikeThis({ hit, onOpen }: { hit: SlideResult; onOpen: (rep: SlideResult) => void }): JSX.Element {
  const [modelReady, setModelReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<MoreLikeThisResult | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.picture.status().then((s) => live && setModelReady(s.model === 'ready'))
    const off = window.sw.picture.onStatus((s) => setModelReady(s.model === 'ready'))
    return () => {
      live = false
      off()
    }
  }, [])
  // a new item in the inspector starts with no results
  useEffect(() => setRes(null), [hit])
  const run = (): void => {
    setBusy(true)
    const asked = hit
    void window.sw.archive
      .moreLikeThis({ kind: hit.kind, deck: hit.deck, slideOrder: hit.slideOrder, reference: hit.reference })
      .then((r) => setRes((cur) => (asked === hit ? r : cur)))
      .catch((e) => setRes({ state: 'error', items: [], error: String(e) }))
      .finally(() => setBusy(false))
  }
  const hint = !modelReady
    ? 'Download the picture-search model in Settings to use this'
    : res?.state === 'not-indexed'
      ? 'Not indexed yet — picture search has not reached this one. Try again in a while.'
      : res?.state === 'none'
        ? 'Nothing similar found in other presentations or the well'
        : res?.state === 'error'
          ? 'Could not look this up just now'
          : 'by what’s on it · other presentations'
  return (
    <div className="more-like-this">
      <div className="mlt-bar">
        <button className="primary-btn" onClick={run} disabled={!modelReady || busy} title={modelReady ? 'Find pictures that look like this one' : 'Needs the picture-search model (Settings)'}>
          More like this
        </button>
        <span className={res && res.state !== 'ok' && modelReady ? 'mlt-hint quiet' : 'mlt-hint'}>{hint}</span>
      </div>
      {res?.state === 'ok' && (
        <div className="mlt-grid">
          {res.items.map((r, i) => (
            <button key={`${r.deck}-${r.slideOrder}-${r.reference}-${i}`} className="mlt-item" title={r.title} onClick={() => onOpen(r)}>
              {r.thumbUrl ? <img src={r.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="mlt-blank" />}
              {r.score && <span className="score-chip meaning">{r.score.label.replace('meaning ', '')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SlideInspector({
  hit,
  pos,
  siblings,
  onNavigate,
  onClose,
  onFullsize,
  onCopyText,
  onCopyRef,
  onCopyImage,
  onReveal,
  onContext,
  pinned,
  onBackToList,
  onOpenSimilar
}: {
  hit: SlideResult
  pinned: boolean
  onBackToList: () => void
  onOpenSimilar: (rep: SlideResult) => void
  pos: string
  siblings: SlideResult[]
  onNavigate: (rep: SlideResult) => void
  onClose: () => void
  onFullsize: () => void
  onCopyText: () => void
  onCopyRef: () => void
  onCopyImage: () => void
  onReveal: () => void
  onContext?: () => void
}): JSX.Element {
  const isSlide = hit.kind === 'slide'
  const kindLabel = hit.kind === 'slide' ? 'slide' : hit.kind === 'well-image' ? 'well image' : hit.kind === 'archive-image' ? 'embedded image' : 'OCR text'
  const [json, setJson] = useState<string | null>(null)
  const [assets, setAssets] = useState<Array<{ thumbUrl: string | null }>>([])
  useEffect(() => {
    setJson(null)
    setAssets([])
    if (isSlide) {
      void window.sw.archive.slideStructure(hit.deck, hit.slideOrder).then(setJson)
      void window.sw.archive.slideImages(hit.deck, hit.slideOrder).then(setAssets)
    }
  }, [hit, isSlide])
  const rows: [string, string][] = [
    ['Presentation', hit.deckTitle || hit.deck || '—'],
    ['File', hit.filename || '—'],
    ...(hit.slideOrder !== null ? ([['Slide', String(hit.slideOrder + 1)]] as [string, string][]) : []),
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Author', authorOf(hit)],
    ['Used in', `${hit.usedInDecks} presentation${hit.usedInDecks === 1 ? '' : 's'}`],
    ['Kind', kindLabel],
    ['Reference', hit.reference]
  ]
  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-head">
        <b>{hit.title}</b>
        <button className="copyref" onClick={onClose}>✕</button>
      </div>
      <div className="inspector-pos">
        {pinned ? (
          <>
            opened from More like this · <button className="link" onClick={onBackToList}>back to the list</button>
          </>
        ) : (
          <>{pos} · ←/→ to navigate</>
        )}
        {hit.score && <span className={`score-chip inline ${hit.score.kind}`}>{hit.score.label}</span>}</div>
      {hit.thumbUrl && <img className="deck-sidebar-cover" src={hit.thumbUrl} alt="" />}
      <div className="details-table">
        {rows.map(([k, v]) => (
          <div className="drow" key={k}>
            <span className="dk">{k}</span>
            <span className="dv">{v}</span>
          </div>
        ))}
        {!isSlide && hit.text && <div className="details-text">{hit.text}</div>}
        {(hit.talkUses ?? []).length > 0 && (
          <>
            <div className="inspector-section">Used in</div>
            <div className="used-in-box">
              {(hit.talkUses ?? []).map((u) => (
                <div className="used-in-row" key={u.relPath}>
                  {u.title}{u.slide !== null ? ` (slide ${u.slide})` : ''} — <button className="link" title="TalkWeaver has no link to a single talk yet, so this shows the talk's file in Finder" onClick={() => void window.sw.archive.revealTalk(u.relPath)}>Show talk file ↗</button>
                </div>
              ))}
            </div>
          </>
        )}
        <MoreLikeThis hit={hit} onOpen={onOpenSimilar} />
        {siblings.length > 1 && (
          <>
            <div className="inspector-section">Other slides in this presentation ({siblings.length - 1})</div>
            <div className="inspector-assets">
              {siblings.map(
                (sib, i) =>
                  sib.thumbUrl && (
                    <img
                      key={`${sib.deck}-${sib.slideOrder}-${i}`}
                      className={sib === hit ? 'inspector-asset wide current' : 'inspector-asset wide'}
                      src={sib.thumbUrl}
                      alt=""
                      title={sib.title}
                      loading="lazy"
                      onClick={() => onNavigate(sib)}
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                    />
                  )
              )}
            </div>
          </>
        )}
        {isSlide && assets.length > 0 && (
          <>
            <div className="inspector-section">Image assets ({assets.length})</div>
            <div className="inspector-assets">
              {assets.map(
                (a, i) =>
                  a.thumbUrl && (
                    <img key={i} className="inspector-asset" src={a.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  )
              )}
            </div>
          </>
        )}
        {isSlide && (
          <>
            <div className="inspector-section">Full JSON</div>
            <pre className="inspector-json">{json ?? '…'}</pre>
          </>
        )}
      </div>
      <div className="details-actions">
        <button className="primary-btn" onClick={onFullsize}>Full size</button>
        <button className="copyref" onClick={onCopyImage}>copy img</button>
        <button className="copyref" onClick={onCopyText}>copy text</button>
        <button className="copyref" onClick={onCopyRef}>copy ref</button>
        <button className="copyref" onClick={onReveal}>reveal</button>
        {onContext && <button className="copyref" onClick={onContext}>in context</button>}
      </div>
    </aside>
  )
}

export function CommandPalette({
  item,
  deckMode,
  onClose,
  onRun
}: {
  item: SlideResult | DeckCard
  deckMode: boolean
  onClose: () => void
  onRun: (a: ActionId) => void
}): JSX.Element {
  const kind = 'kind' in item ? (item as SlideResult).kind : undefined
  const all = actionItems(deckMode, kind)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const filtered = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all
  useEffect(() => setHi(0), [q])
  const title = item.title
  return (
    <div className="overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={`Actions for “${title}”…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((h) => Math.min(h + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(h - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (filtered[hi]) onRun(filtered[hi].id)
            }
          }}
        />
        <div className="cmd-list">
          {filtered.map((a, i) => (
            <button key={a.id} className={i === hi ? 'cmd-item active' : 'cmd-item'} onMouseEnter={() => setHi(i)} onClick={() => onRun(a.id)}>
              <span className="cmd-label">{a.label}</span>
              {a.shortcut && <kbd className="cmd-shortcut">{a.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <div className="ss-empty">no actions</div>}
        </div>
      </div>
    </div>
  )
}

// The cheat sheet (⌘/, also ?): generated from the command registry with his own shortcuts applied. Every
// command is listed; one with no shortcut shows None. The Review and Triage screens' own keys follow.
