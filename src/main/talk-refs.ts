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
 *    08/image-refs.ts REF_RE in TalkWeaver's src/main/image-refs.ts) or a path inside a folder
 *    called `_assets`. A target with a URL scheme never counts. A talk's own `assets/img-xxxxxxx.png`
 *    is a copy beside the talk, not the pool file: counted only with `includeTalkAssets`.
 *
 * Slide numbers: `#` is the talk title and never a slide (14-outline-tree.mjs:155-160); every `##` to
 * `######` heading is one slide, in order (emitNodeSlides, 08-source-adapters.mjs:1715-1780). A
 * generated title slide comes first unless `auto_title_slide` is off (DECK_FLAG_OFF, deck-settings.mjs:34)
 * or a heading carries `{role=opening}` (08-source-adapters.mjs:2016-2025). Approximation: a `{compare}`
 * heading that folds two `####` children into one slide is not modelled.
 */

export interface ImageRef {
  /** Pool id: 7 hex digits, no `img-` prefix. */
  id: string
  /** 1-based slide number as the strip numbers slides (approximate; see above). */
  slide: number
}

export interface TalkRefs {
  /** Title from frontmatter `title:`, else the `#` heading, else ''. */
  title: string
  refs: ImageRef[]
}

export interface ExtractOptions {
  /** Also count `assets/img-xxxxxxx.ext` copies kept beside the talk (default: pool references only). */
  includeTalkAssets?: boolean
}

const IMAGE_SYNTAX = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*((?:\{[^}]*\}\s*)*)$/
const POOL_NAME = /^img-(?:img-)?([0-9a-f]{7,})$/i
const OFF = new Set(['false', 'no', 'off', 'hide', '0'])

/** 'pool' for a pooled image, 'local' for a pool-named file kept elsewhere, null otherwise. */
export function classifyTarget(target: string): { id: string; via: 'pool' | 'local' } | null {
  let t = target.trim().replace(/^<|>$/g, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null // URL scheme: never the pool
  t = t.replace(/[?#].*$/, '')
  try { t = decodeURIComponent(t) } catch { /* keep as written */ }
  const parts = t.split(/[\\/]/)
  const file = parts.pop() ?? ''
  const hasExt = /\.[A-Za-z0-9]{2,5}$/.test(file)
  const m = POOL_NAME.exec(file.replace(/\.[A-Za-z0-9]{2,5}$/, ''))
  if (!m) return null
  const id = m[1].toLowerCase().slice(0, 7)
  if (parts.length === 0 && !hasExt) return { id, via: 'pool' } // bare id
  if (parts[parts.length - 1] === '_assets') return { id, via: 'pool' }
  return { id, via: 'local' }
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
const TRIGGER_ONLY = /^\s*(\{[^}]*\}\s*)+$/

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

  let deckTitle = ''
  let explicitOpening = false
  let slide = 0 // headings seen
  let inNotes = false
  let fence: { marker: string } | null = null
  let afterHeading = -1 // line index of the last heading, to find its trigger block
  const found: Array<{ id: string; slideIdx: number }> = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) { if (fenceCloses(line, fence)) fence = null; continue }
    const open = fenceOpen(line)
    if (open) { fence = open; continue }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^#\s+(.+)/)) && !line.startsWith('##')) {
      deckTitle = m[1].replace(/\s*\{[^}]*\}\s*$/, '').trim()
      continue
    }
    if ((m = line.match(/^(#{2,6})\s+(.+)/))) {
      inNotes = false
      slide += 1
      afterHeading = i
      if (/\{[^}]*\brole\s*=\s*["']?opening\b/.test(m[2])) explicitOpening = true
      continue
    }
    const t = line.trim()
    if (t.toLowerCase() === ':::notes') { inNotes = true; continue }
    if (t === ':::' && inNotes) { inNotes = false; continue }
    if (afterHeading >= 0) {
      // the heading's trigger block: the first non-blank line after it and the trigger-only lines that follow
      let j = afterHeading + 1
      while (j < i && !lines[j].trim()) j++
      let inBlock = j <= i && TRIGGER_ONLY.test(lines[j] ?? '')
      for (let k = j; inBlock && k < i; k++) if (!TRIGGER_ONLY.test(lines[k])) inBlock = false
      if (inBlock && TRIGGER_ONLY.test(line) && /\brole\s*=\s*["']?opening\b/.test(line)) explicitOpening = true
    }
    if (inNotes || slide === 0) continue
    const im = IMAGE_SYNTAX.exec(t)
    if (!im) continue
    const c = classifyTarget(im[2])
    if (!c || (c.via === 'local' && !opts.includeTalkAssets)) continue
    const key = `${c.id}@${slide}`
    if (!seen.has(key)) { seen.add(key); found.push({ id: c.id, slideIdx: slide }) }
  }

  const cover = !OFF.has((meta['auto_title_slide'] ?? '').toLowerCase()) && !explicitOpening
  const offset = cover ? 1 : 0
  return {
    title: (meta['title'] || deckTitle).trim(),
    refs: found.map((f) => ({ id: f.id, slide: f.slideIdx + offset }))
  }
}
