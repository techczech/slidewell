/**
 * Pure reference extractor: a TalkWeaver talk's Markdown -> which pooled images it uses and on which
 * slide. No I/O. The pool id is the 7-hex id of an `_assets/img-xxxxxxx.*` file (the same id
 * well.ts gives a vault image, without the `img-` prefix).
 *
 * It mirrors TalkWeaver's compiler, so a picture counts as "used" exactly when the compiler would
 * put it on a slide:
 *  - Image syntax is a whole line `![alt](target "title"){attrs}` (IMAGE_SYNTAX_RE,
 *    compiler/scripts/lib/image-line-rules.mjs:102). HTML <img>, Obsidian embeds and brace
 *    attributes are not image syntax there, so they never count.
 *  - Only lines on a slide count: not inside code fences (image-line-rules.mjs:79-90 fence rules,
 *    14-outline-tree.mjs:135-148), not inside `:::notes` (image-line-rules.mjs:116-121), not inside
 *    HTML comments (html-comments.mjs:12, applied at 08-source-adapters.mjs:441), and not in the
 *    preamble above the first `##` (only tree.root.children become slides, 08-source-adapters.mjs:1942).
 *  - A target is a pooled image when it is a bare id `img-xxxxxxx` (legacy `img-img-xxxxxxx`;
 *    REF_RE in TalkWeaver's src/main/image-refs.ts) or a path inside a folder called `_assets`.
 *    A target with a URL scheme never counts. A talk-local copy is a target that is exactly
 *    `assets/img-xxxxxxx.<image ext>` (optionally `./assets/…`): the `assets` folder beside the
 *    outline. It counts only when the caller passes the pool and the id is in it; any other path
 *    with a pool-like file name never counts. Filtering happens before de-duplication, so a
 *    rejected copy never hides a later valid reference to the same image on the same slide.
 *
 * Slide numbers: `#` is the talk title and never a slide (14-outline-tree.mjs:155-160); every `##` to
 * `######` heading is one slide, in order (emitNodeSlides, 08-source-adapters.mjs:1715-1780). A
 * generated title slide comes first unless `auto_title_slide` is off (readDeckFlag, deck-settings.mjs:34)
 * or some slide's role is `opening` (hasExplicitOpening, 08-source-adapters.mjs:2020-2024).
 * A slide's role is the LAST `role` token among, in order: the heading's trailing `{…}` groups
 * (parseHeadingAttrs, 02-triggers-layout.mjs:54), its Trigger block (Object.assign per line,
 * 14-outline-tree.mjs:177-185), then every other Trigger-only line in its body outside fences and
 * notes (contentLinesAndAttrs folds stray Trigger lines into the same attrs object,
 * 08-source-adapters.mjs:1577-1583, read as slide.attrs.role at 1257). So `## S {role=opening}`
 * followed by `{role=content}` is a content slide and the title slide is still generated.
 * A wrong slide number is worse than none, so a number is kept only when it is certain: when nothing
 * the extractor does not model appears in the talk at or before that slide. Not modelled, and so
 * turning that slide's and every later number into 0 (unknown): a fold token (see FOLD_*; in a
 * heading, its Trigger lines, or talk-wide `triggers:`) on a heading with child headings; a split
 * token, quote or `**Timeline:**` block on a slide with no image line (so possibly a single block
 * that splits into continuations); and an
 * authored opening below a `##` section (the opening-first reorder, 08-source-adapters.mjs:1973-2008;
 * unknown from that section's heading on).
 */

export interface ImageRef {
  /** Pool id: 7 hex digits, no `img-` prefix. */
  id: string
  /** 1-based slide number as TalkWeaver numbers slides, or 0 when it is not certain (see above). */
  slide: number
  /** 'pool' = named through the pool; 'local' = the talk's own `assets/` copy of a pool image. */
  via: 'pool' | 'local'
}

export interface TalkRefs {
  /** Title from frontmatter `title:`, else the `#` heading, else ''. */
  title: string
  refs: ImageRef[]
}

export interface ExtractOptions {
  /** The pool's ids. When given, a talk-local copy `assets/img-xxxxxxx.<ext>` counts if its id is here. */
  pool?: ReadonlySet<string>
}

const IMAGE_SYNTAX = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*((?:\{[^}]*\}\s*)*)$/
const POOL_NAME = /^img-(?:img-)?([0-9a-f]{7,})$/i
const LOCAL_COPY = /^(?:\.\/)?assets\/img-([0-9a-f]{7,})\.(?:png|jpe?g|gif|webp|avif|svg)$/i
const OFF = new Set(['false', 'no', 'off', 'hide', '0'])

/** 'pool' for a pooled image, 'local' for a talk-local `assets/img-xxxxxxx.<ext>` copy, null otherwise. */
export function classifyTarget(target: string): { id: string; via: 'pool' | 'local' } | null {
  let t = target.trim().replace(/^<|>$/g, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null // URL scheme: never the pool
  t = t.replace(/[?#].*$/, '')
  try { t = decodeURIComponent(t) } catch { /* keep as written */ }
  const local = LOCAL_COPY.exec(t)
  if (local) return { id: local[1].toLowerCase().slice(0, 7), via: 'local' }
  const parts = t.split(/[\\/]/)
  const file = parts.pop() ?? ''
  const hasExt = /\.[A-Za-z0-9]{2,5}$/.test(file)
  const m = POOL_NAME.exec(file.replace(/\.[A-Za-z0-9]{2,5}$/, ''))
  if (!m) return null
  const id = m[1].toLowerCase().slice(0, 7)
  if (parts.length === 0 && !hasExt) return { id, via: 'pool' } // bare id
  if (parts[parts.length - 1] === '_assets') return { id, via: 'pool' }
  return null // a pool-like name anywhere else is not the pool
}

/** The pool id a reference target names (pooled forms only), or null. */
export function poolIdOf(target: string): string | null {
  const c = classifyTarget(target)
  return c && c.via === 'pool' ? c.id : null
}

const fenceOpen = (line: string): { marker: string } | null => {
  const m = line.replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})(.*)$/)
  return m ? { marker: m[1] } : null
}
const fenceCloses = (line: string, open: { marker: string }): boolean => {
  const m = line.replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})\s*$/)
  return Boolean(m && m[1][0] === open.marker[0] && m[1].length >= open.marker.length)
}
// TRIGGER_LINE_RE, trigger-tokenizer.mjs:2 (tested on the trimmed line)
const TRIGGER_LINE = /^\{[^}]*\}(\s*\{[^}]*\})*$/

/** The tokens of `{…}` group bodies, quotes unwrapped (tokenizeTriggerBody, trigger-tokenizer.mjs:13). */
function tokensIn(groups: string[]): string[] {
  const out: string[] = []
  for (const body of groups) {
    let i = 0
    while (i < body.length) {
      while (i < body.length && (/\s/.test(body[i]) || body[i] === ',')) i++
      let tok = ''
      while (i < body.length && !/\s/.test(body[i]) && body[i] !== ',') {
        if (body[i] === '"') { i++; while (i < body.length && body[i] !== '"') tok += body[i++]; i++ }
        else tok += body[i++]
      }
      if (tok) out.push(tok)
    }
  }
  return out
}
/** The last `role` value among these tokens, or undefined. `key=value`, or the colon form `key:value` (parseHeadingAttrs, 02-triggers-layout.mjs:88-108). */
function roleIn(tokens: string[]): string | undefined {
  let role: string | undefined
  for (const tok of tokens) {
    // (a token with an `=` is always the equals form, so `role:x=y` is not a role)
    if (tok.startsWith('role=')) role = tok.slice(5)
    else if (tok.startsWith('role:') && !tok.includes('=')) role = tok.slice(5)
  }
  return role
}
/**
 * Tokens that can change how many slides a heading emits. Folds: {carousel}, {cards=grid|rows},
 * {image-grid}, {contrast}, {columns}/{cols}/{2col}/{3col} and {compare} absorb `####` children into
 * one slide (foldChildLayoutNodes, 08-source-adapters.mjs:1876-1955). Splits: a timeline or quote
 * slide may become several continuation slides (continuationSplitForNode, 08-source-adapters.mjs:1592;
 * timelineContinuationParts, splitQuoteSlideBlocks). Bare words resolve through TalkWeaver's trigger
 * dictionary (trigger-dictionary.generated.mjs); these are the words that resolve to the keys and
 * layouts above. Any other token keeps one slide per heading.
 */
// folds act only on a heading that has child headings; splits only on a slide with a single block
const FOLD_KEYS = new Set(['carousel', 'cards', 'cols', 'contrast', 'compare', 'columns'])
const FOLD_LAYOUTS = new Set(['cards', 'image-grid', 'contrast', 'columns', 'compare'])
const FOLD_WORDS = new Set(['carousel', 'cards', '2col', '3col', 'columns', 'compare', 'contrast', 'image-grid', 'imagegrid'])
const SPLIT_KEYS = new Set(['timeline'])
const SPLIT_LAYOUTS = new Set(['timeline', 'timeline-visual', 'quote'])
const SPLIT_WORDS = new Set(['quote', 'timeline', 'timeline-visual', 'timelinedynamic', 'timelinehorizontal', 'timeline-pills', 'timelinepills', 'timelinespine', 'timelinevertical'])
function tokenKind(tok: string): 'fold' | 'split' | null {
  const eq = tok.indexOf('=')
  const colon = tok.indexOf(':')
  const cut = eq > 0 ? eq : colon > 0 ? colon : -1
  if (cut < 0) {
    const w = tok.toLowerCase()
    return FOLD_WORDS.has(w) ? 'fold' : SPLIT_WORDS.has(w) ? 'split' : null
  }
  const key = tok.slice(0, cut).toLowerCase()
  const value = tok.slice(cut + 1).toLowerCase()
  if (key === 'layout') return FOLD_LAYOUTS.has(value) ? 'fold' : SPLIT_LAYOUTS.has(value) ? 'split' : null
  return FOLD_KEYS.has(key) ? 'fold' : SPLIT_KEYS.has(key) ? 'split' : null
}
/** Bare words that resolve to some `layout` (trigger-dictionary.generated.mjs); only `compare` matters here, but any other layout word overrides it. */
const LAYOUT_WORDS = new Set([
  'statement', 'list', 'cards', 'chart', 'closing', 'code', 'columns', 'compare', 'conceptmap', 'contrast', 'copy-visual',
  'cta-screenshots', 'cycle', 'equation', 'flow', 'grid', 'iconrow', 'icon-row', 'image-claim', 'image-grid', 'imagegrid',
  'image-quote', 'imagequote', 'links', 'list-visual', 'media', 'mindmap', 'orgchart', 'process', 'agenda', 'pyramid', 'quote',
  'sigmoid', 'smartart', 'stats', 'steps', 'stairs', 'stmt-list', 'stmtlist', 'system-map', 'table', 'timeline',
  'timeline-visual', 'timetable', 'title', 'trace'
])
type FoldAttrs = { layout?: string; carousel?: string; cards?: string; cols?: string }
/** Fold the tokens into the attrs that decide a container fold, last one wins (parseHeadingAttrs). */
function applyFoldAttrs(a: FoldAttrs, toks: string[], allowLayout = true): void {
  for (const tok of toks) {
    const eq = tok.indexOf('=')
    const colon = tok.indexOf(':')
    const cut = eq > 0 ? eq : colon > 0 && /^[\w-]+$/.test(tok.slice(0, colon)) ? colon : -1
    let key: string
    let value: string
    if (cut > 0) { key = tok.slice(0, cut); value = tok.slice(cut + 1) }
    else if (!/^[\w-]+$/.test(tok)) continue
    else if (LAYOUT_WORDS.has(tok)) { key = 'layout'; value = tok }
    else if (tok === 'carousel') { key = 'carousel'; value = 'true' }
    else if (tok === '2col' || tok === '3col') { key = 'cols'; value = tok[0] }
    else { key = tok; value = 'true' } // unknown bare word: recorded as a flag
    if (key === 'layout' && !allowLayout) continue // frontmatter triggers may not set a layout
    if (key === 'layout' || key === 'carousel' || key === 'cards' || key === 'cols') a[key] = value
  }
}
/**
 * Does this heading fold its children as {compare}? foldChildLayoutNodes (08-source-adapters.mjs:1876-1937)
 * tries carousel, static cards (grid/rows), image-grid, contrast and columns first; compare (layout
 * compare, two or more children) keeps only the first two children's own content (_compareHalves).
 */
function foldsAsCompare(a: FoldAttrs, children: number): boolean {
  if (a.layout !== 'compare' || children < 2) return false
  if (a.carousel === 'true') return false
  if (a.cards === 'grid' || a.cards === 'rows') return false
  if (a.cols !== undefined && a.cols !== 'true') return false
  return true
}
/** Does this heading fold as {columns}, merging its children's lines into its own (same order of checks)? */
function foldsAsColumns(a: FoldAttrs, children: number): boolean {
  if (children < 2) return false
  if (a.carousel === 'true') return false
  if (a.cards === 'grid' || a.cards === 'rows') return false
  if (a.layout === 'image-grid') return false
  if (a.layout === 'contrast' && children <= 3) return false
  return a.layout === 'columns' || (a.cols !== undefined && a.cols !== 'true')
}

// A quote (`>` or a paragraph starting with a double quote, quoteFromQuotedParagraph, 02-triggers-layout.mjs:664)
// or a `**Timeline:**` block splits only when it is the slide's single block
// (quoteBlockOnQuoteSlide, quote-layout.mjs:430; timelineContinuationParts, timeline-layout.mjs:126).
const QUOTE_START = /^(?:>|"|“)/
const TIMELINE_START = /^\*\*Timeline:\*\*\s*$/i

/** Trailing `{…}` groups of a heading's text, peeled right to left (parseHeadingAttrs). */
function headingGroups(text: string): string[] {
  const groups: string[] = []
  let t = text.trimEnd()
  for (;;) {
    const m = t.match(/^([\s\S]*?)\s*\{([^}]*)\}$/)
    if (!m) break
    groups.unshift(m[2])
    t = m[1].trimEnd()
  }
  return groups
}
const triggerGroups = (line: string): string[] => [...line.matchAll(/\{([^}]*)\}/g)].map((g) => g[1])

export function extractTalkRefs(markdown: string, opts: ExtractOptions = {}): TalkRefs {
  let raw = markdown.replace(/\r\n?/g, '\n')
  const meta: Record<string, string> = {}
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end >= 0) {
      for (const l of raw.slice(3, end).split('\n')) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l)
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
      }
      raw = raw.slice(end + 4).replace(/^\n/, '')
    }
  }
  // blank HTML comments but keep newlines, as the compiler does
  const lines = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, '')).split('\n')

  let talkTitle = ''
  const roles: Array<string | undefined> = [] // per slide: its role token, last one wins
  const levels: number[] = [] // per slide: its heading level
  // the first slide at which numbering stops being certain (a construct the extractor does not model)
  let uncertainFrom = Infinity
  const unsure = (at: number): void => { uncertainFrom = Math.min(uncertainFrom, at) }
  const fold: boolean[] = [] // per slide: a token that folds child headings into it
  const splitMarker: boolean[] = [] // per slide: a split token or a `**Timeline:**` block
  const quoteMarker: boolean[] = [] // per slide: a quote
  const imageLine: boolean[] = [] // per slide: an image-syntax line (so the slide has more than one block)
  // per slide: a fenced block, certainly a block of its own beside a quote (a list after a quote is
  // not: it can be folded into the quote as its attribution, foldQuoteAttribution)
  const otherBlock: boolean[] = []
  // talk-wide trigger defaults apply to every slide (deckTriggerDefaults, 08-source-adapters.mjs:595)
  const triggerDefaults = tokensIn([(meta['triggers'] ?? '').replace(/[{}]/g, ' ')])
  const defaults = triggerDefaults.map(tokenKind)
  // a role in talk-wide triggers applies to every slide (attrs = { ...deckTriggerDefaults, ... }): not modelled
  if (roleIn(triggerDefaults) !== undefined) unsure(1)
  const foldAttrs: FoldAttrs[] = [] // per slide: the attrs container-fold resolution reads (resolvedNodeAttrs, fences included)
  const slideLayout: Array<string | undefined> = [] // per slide: the layout the slide renders with (fences excluded)
  const noteTokens = (k: number, toks: string[]): void => {
    for (const kind of toks.map(tokenKind)) {
      if (kind === 'fold') fold[k] = true
      if (kind === 'split') splitMarker[k] = true
    }
  }
  let slide = 0 // headings seen
  let inNotes = false
  let fence: { marker: string } | null = null
  const found: Array<{ id: string; slideIdx: number; via: 'pool' | 'local' }> = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      if (fenceCloses(line, fence)) { fence = null; continue }
      // container-fold resolution reads Trigger-shaped lines even inside fences (resolvedNodeAttrs,
      // 08-source-adapters.mjs:1787-1810); the slide's own attrs (role, splits) do not
      const ft = line.trim()
      if (slide > 0 && !inNotes && TRIGGER_LINE.test(ft)) {
        const toks = tokensIn(triggerGroups(ft))
        if (toks.some((x) => tokenKind(x) === 'fold')) fold[slide] = true
        applyFoldAttrs(foldAttrs[slide], toks)
      }
      continue
    }
    const open = fenceOpen(line)
    if (open) { if (slide > 0 && !inNotes) otherBlock[slide] = true; fence = open; continue }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^#\s+(.+)/)) && !line.startsWith('##')) {
      talkTitle = m[1].replace(/\s*\{[^}]*\}\s*$/, '').trim()
      continue
    }
    if ((m = line.match(/^(#{2,6})\s+(.+)/))) {
      inNotes = false
      slide += 1
      levels[slide] = m[1].length
      const toks = tokensIn(headingGroups(m[2]))
      roles[slide] = roleIn(toks)
      noteTokens(slide, toks)
      foldAttrs[slide] = {}
      applyFoldAttrs(foldAttrs[slide], triggerDefaults, false)
      applyFoldAttrs(foldAttrs[slide], toks)
      slideLayout[slide] = foldAttrs[slide].layout
      continue
    }
    const t = line.trim()
    if (t.toLowerCase() === ':::notes') { inNotes = true; continue }
    if (t === ':::' && inNotes) { inNotes = false; continue }
    if (inNotes || slide === 0) continue
    // every Trigger-only line of the slide's body, in order: the Trigger block and stray ones alike.
    // (A chart object token line holds exactly one `chart` token, so it can never set a role.)
    if (TRIGGER_LINE.test(t)) {
      const toks = tokensIn(triggerGroups(t))
      const r = roleIn(toks)
      if (r !== undefined) roles[slide] = r
      noteTokens(slide, toks)
      applyFoldAttrs(foldAttrs[slide], toks)
      const own: FoldAttrs = { layout: slideLayout[slide] }
      applyFoldAttrs(own, toks)
      slideLayout[slide] = own.layout
      continue
    }
    if (TIMELINE_START.test(t)) splitMarker[slide] = true
    if (QUOTE_START.test(t)) quoteMarker[slide] = true
    const im = IMAGE_SYNTAX.exec(t)
    if (!im) continue
    imageLine[slide] = true
    const c = classifyTarget(im[2])
    // filter first, then de-duplicate: a rejected copy must not hide a later valid reference
    if (!c || (c.via === 'local' && !opts.pool?.has(c.id))) continue
    const key = `${c.id}@${slide}`
    if (!seen.has(key)) { seen.add(key); found.push({ id: c.id, slideIdx: slide, via: c.via }) }
  }

  // parents by heading depth (a deeper heading nests under the nearest shallower one, gaps tolerated)
  const parent: number[] = []
  const stack: number[] = []
  for (let k = 1; k <= slide; k++) {
    while (stack.length && levels[stack[stack.length - 1]] >= levels[k]) stack.pop()
    parent[k] = stack.length ? stack[stack.length - 1] : 0
    stack.push(k)
  }
  const kidsOf = (k: number): number[] => {
    const kids: number[] = []
    for (let j = k + 1; j <= slide && levels[j] > levels[k]; j++) if (parent[j] === k) kids.push(j)
    return kids
  }
  // the slides whose lines end up in k's own lines: k, plus (when k folds as columns) its children's
  const merged = (k: number): number[] => {
    const kids = kidsOf(k)
    return foldsAsColumns(foldAttrs[k] ?? {}, kids.length) ? [k, ...kids.flatMap(merged)] : [k]
  }
  // slides whose content a {compare} fold discards: everything below the compare heading except
  // the lines of its first two children (_compareHalves, 08-source-adapters.mjs:1925-1937); and when
  // the slide renders as compare, its own lines too (blocks = the two halves only, 1150-1161). When
  // the fold and the rendered layout disagree (a {compare} only inside a fence), the halves and the
  // heading's own lines are kept: whether they render is not modelled.
  const discarded = new Set<number>()
  for (let k = 1; k <= slide; k++) {
    const kids = kidsOf(k)
    if (!foldsAsCompare(foldAttrs[k] ?? {}, kids.length)) continue
    const halves = new Set([...merged(kids[0]), ...merged(kids[1])])
    if (slideLayout[k] === 'compare') discarded.add(k)
    for (let j = k + 1; j <= slide && levels[j] > levels[k]; j++) if (!halves.has(j)) discarded.add(j)
  }
  for (let k = 1; k <= slide; k++) {
    const hasChildren = k < slide && levels[k + 1] > levels[k]
    const folds = fold[k] || defaults.includes('fold')
    const splits = splitMarker[k] || defaults.includes('split')
    const quoteAlone = quoteMarker[k] && !imageLine[k] && !otherBlock[k]
    if ((folds && hasChildren) || (splits && !imageLine[k]) || quoteAlone) unsure(k)
  }
  const opening = roles.findIndex((r) => r === 'opening')
  // an authored opening below a `##` section may be moved in front of that section's divider, or
  // the divider dropped (OPENING-FIRST ORDERING, 08-source-adapters.mjs:1973-2008)
  if (opening > 0 && levels[opening] > 2) {
    let p = opening - 1
    while (p >= 1 && levels[p] !== 2) p--
    if (p >= 1) unsure(p) // only below a `##` section heading
  }
  const cover = !OFF.has((meta['auto_title_slide'] ?? '').toLowerCase()) && opening < 0
  const offset = cover ? 1 : 0
  const refs: ImageRef[] = []
  const kept = new Set<string>()
  for (const f of found) {
    if (discarded.has(f.slideIdx)) continue
    const slide = f.slideIdx < uncertainFrom ? f.slideIdx + offset : 0 // 0 = not certain
    const key = `${f.id}@${slide}`
    if (!kept.has(key)) { kept.add(key); refs.push({ id: f.id, slide, via: f.via }) }
  }
  return { title: (meta['title'] || talkTitle).trim(), refs }
}
