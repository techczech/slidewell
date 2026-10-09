/**
 * Pure reference extractor: a TalkWeaver talk's Markdown -> which pooled images it uses and on which
 * slide. No I/O. The pool id is the 7-hex id of an `_assets/img-xxxxxxx.*` file (the same id
 * well.ts gives a vault image, without the `img-` prefix).
 *
 * Reference syntaxes recognised (TalkWeaver's own is `![alt](img-xxxxxxx)`, with the legacy
 * `img-img-xxxxxxx`; the others are what talks and imports have been seen to carry):
 *   Markdown  ![alt](img-abc1234)  ![alt](assets/img-abc1234.png "title")  ![alt](<../_assets/img-abc1234.webp>)
 *   Obsidian  ![[img-abc1234]]  ![[_assets/img-abc1234.webp|300]]
 *   HTML      <img src="img-abc1234.webp">
 *   Directive {image=img-abc1234} {bg="img-abc1234"} (any key=value inside braces)
 *   Frontmatter  cover: img-abc1234
 * A reference counts only when its target's file name is a pool id, so remote URLs and other files
 * never match. Fenced code is ignored.
 *
 * Slide numbers follow how TalkWeaver's strip numbers slides, approximately: a generated title slide
 * first (unless `auto_title_slide` is off or the talk opens with an explicit `{role=opening}`), then
 * one slide per heading of level 1 to 3. A reference before the first heading sits on slide 1.
 */

export interface ImageRef {
  /** Pool id: 7 hex digits, no `img-` prefix. */
  id: string
  /** 1-based slide number, as the strip numbers slides (approximate; see above). */
  slide: number
}

export interface TalkRefs {
  /** Title from frontmatter `title:`, else the first heading, else ''. */
  title: string
  refs: ImageRef[]
}

const POOL_NAME = /^img-(?:img-)?([0-9a-f]{7,})$/i

/** The pool id a reference target names, or null. Accepts paths, URL-encoding and a file extension. */
export function poolIdOf(target: string): string | null {
  let t = target.trim().replace(/^<|>$/g, '')
  t = t.replace(/[?#].*$/, '')
  try { t = decodeURIComponent(t) } catch { /* keep as written */ }
  const file = t.split(/[\\/]/).pop() ?? ''
  const stem = file.replace(/\.[A-Za-z0-9]{2,5}$/, '')
  const m = POOL_NAME.exec(stem)
  return m ? m[1].toLowerCase().slice(0, 7) : null
}

function targetsIn(line: string, inFrontmatter: boolean): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  const md = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g
  while ((m = md.exec(line))) out.push(m[1])
  const ob = /!\[\[([^\]|]+)/g
  while ((m = ob.exec(line))) out.push(m[1])
  const html = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  while ((m = html.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  const braces = /\{([^}]*)\}/g
  while ((m = braces.exec(line))) {
    const kv = /[A-Za-z][\w-]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}"']+))/g
    let k: RegExpExecArray | null
    while ((k = kv.exec(m[1]))) out.push(k[1] ?? k[2] ?? k[3])
  }
  if (inFrontmatter) {
    const fm = /^[A-Za-z][\w-]*\s*:\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (fm) out.push(fm[1])
  }
  return out
}

const OFF = new Set(['false', 'off', 'no', '0'])

export function extractTalkRefs(markdown: string): TalkRefs {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const meta: Record<string, string> = {}
  const frontLines: string[] = []
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---')
    if (end > 0) {
      for (let n = 1; n < end; n++) {
        frontLines.push(lines[n])
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[n])
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
      }
      i = end + 1
    }
  }
  const body = lines.slice(i)
  const explicitOpening = /\{[^}]*\brole\s*=\s*["']?opening\b/.test(body.join('\n'))
  const cover = !OFF.has((meta['auto_title_slide'] ?? '').toLowerCase()) && !explicitOpening

  const found: ImageRef[] = []
  const seen = new Set<string>()
  const add = (id: string, slide: number): void => {
    const key = `${id}@${slide}`
    if (!seen.has(key)) { seen.add(key); found.push({ id, slide }) }
  }
  // frontmatter references belong to the generated title slide, or slide 1 without one
  for (const l of frontLines) for (const t of targetsIn(l, true)) { const id = poolIdOf(t); if (id) add(id, 1) }

  let slide = cover ? 1 : 0
  let headings = 0
  let title = meta['title'] ?? ''
  let fence: string | null = null
  for (const l of body) {
    const f = /^\s*(```+|~~~+)/.exec(l)
    if (f) {
      if (fence === null) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const h = /^(#{1,6})\s+(.*?)\s*(?:\{[^}]*\})?\s*#*\s*$/.exec(l)
    if (h && h[1].length <= 3) {
      slide += 1
      headings += 1
      if (!title && headings === 1) title = h[2]
    }
    for (const t of targetsIn(l, false)) {
      const id = poolIdOf(t)
      if (id) add(id, Math.max(slide, 1))
    }
  }
  return { title: title.trim(), refs: found }
}
