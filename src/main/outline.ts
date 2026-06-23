/**
 * Pure presentation.json (Core A schema v2.1) → mechanical TalkWeaver Outline markdown.
 * No Electron/Node imports — unit-tested in isolation (test/outline.test.ts).
 *
 * Mechanical = faithful skeleton, no layout authoring: one `###` per slide; bullets, tables,
 * notes, images verbatim. Drives the sideband "convert" pipeline (src/main/convert.ts) for
 * throwaway conversions of OTHER PEOPLE'S decks — hence the `origin: external` stamp.
 */

export interface OutlineResult {
  markdown: string
  /** image/video `src` values referenced — the caller copies these into the output `assets/`. */
  assets: string[]
}

export interface OutlineOpts {
  title?: string
  /** image.src → recognised OCR text. Present (non-empty) only when the optional OCR pass ran. */
  ocrBySrc?: Record<string, string>
}

// ---- pure helpers (no node:path, to keep this module import-free / trivially testable) ----
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function baseName(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

type Block = Record<string, unknown>
type Run = { text?: string; bold?: boolean; italic?: boolean; url?: string }
type ListItem = { text?: string; level?: number; url?: string; runs?: Run[]; children?: ListItem[] }
type SmartNode = { text?: string; level?: number; children?: SmartNode[] }
type TableCell = { text?: string; is_header?: boolean }

function renderRuns(runs: Run[]): string {
  let out = ''
  for (const r of runs) {
    const t = r?.text ?? ''
    if (!t) continue
    if (r.url) {
      out += `[${t}](${r.url})`
      continue
    }
    let piece = t
    if (r.italic) piece = `_${piece}_`
    if (r.bold) piece = `**${piece}**`
    out += piece
  }
  return out
}

function itemText(it: ListItem): string {
  if (Array.isArray(it.runs) && it.runs.length) return renderRuns(it.runs)
  const t = it.text ?? ''
  return it.url ? `[${t}](${it.url})` : t
}

function renderList(items: ListItem[], numbered: boolean, lines: string[]): void {
  for (const it of items ?? []) {
    const level = Math.max(0, Number(it.level) || 0)
    const marker = numbered ? '1.' : '-'
    lines.push(`${'  '.repeat(level)}${marker} ${itemText(it)}`)
    if (Array.isArray(it.children) && it.children.length) renderList(it.children, numbered, lines)
  }
}

function renderSmartArt(nodes: SmartNode[], lines: string[]): void {
  for (const n of nodes ?? []) {
    const depth = Math.max(0, (Number(n.level) || 1) - 1)
    lines.push(`${'  '.repeat(depth)}- ${n.text ?? ''}`)
    if (Array.isArray(n.children) && n.children.length) renderSmartArt(n.children, lines)
  }
}

function renderTable(rows: TableCell[][]): string {
  const cell = (c: TableCell): string => (c?.text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const out: string[] = []
  rows.forEach((row, i) => {
    out.push(`| ${row.map(cell).join(' | ')} |`)
    if (i === 0) out.push(`| ${row.map(() => '---').join(' | ')} |`)
  })
  return out.join('\n')
}

/** Render a slide's body blocks (title echo already stripped by the caller). */
function renderBlocks(content: Block[], assets: string[], ocrBySrc: Record<string, string>): string[] {
  const chunks: string[] = []
  for (const b of content) {
    switch (b.type) {
      case 'heading': {
        const text = ((b.text as string) ?? '').trim()
        if (text) chunks.push(`**${text}**`) // sub-heading inside a slide → bold line (mechanical)
        break
      }
      case 'list': {
        const lines: string[] = []
        renderList((b.items as ListItem[]) ?? [], b.style === 'numbered', lines)
        if (lines.length) chunks.push(lines.join('\n'))
        break
      }
      case 'image': {
        const src = (b.src as string) ?? ''
        if (!src) break
        assets.push(src)
        const alt = ((b.alt as string) ?? '').replace(/[[\]]/g, '')
        let chunk = `![${alt}](assets/${baseName(src)})`
        const ocr = ocrBySrc[src]
        if (ocr && ocr.trim()) chunk += `\n\n*Image text: ${ocr.replace(/\s*\n\s*/g, '; ').trim()}*`
        chunks.push(chunk)
        break
      }
      case 'table': {
        const rows = (b.rows as TableCell[][]) ?? []
        if (rows.length) chunks.push(renderTable(rows))
        break
      }
      case 'smart_art': {
        const lines: string[] = []
        renderSmartArt((b.nodes as SmartNode[]) ?? [], lines)
        if (lines.length) chunks.push(lines.join('\n'))
        break
      }
      case 'video': {
        const src = (b.src as string) ?? ''
        if (!src) break
        const title = (b.title as string) || 'video'
        if (isHttp(src)) chunks.push(`[▶ ${title}](${src})`)
        else {
          assets.push(src)
          chunks.push(`[▶ ${title}](assets/${baseName(src)})`)
        }
        break
      }
      case 'link': {
        const url = (b.url as string) ?? ''
        const text = (b.text as string) || url
        if (url) chunks.push(`[${text}](${url})`)
        break
      }
      case 'shape': {
        const runs = b.runs as Run[] | undefined
        const text = Array.isArray(runs) && runs.length ? renderRuns(runs) : ((b.text as string) ?? '')
        if (text.trim()) chunks.push(text.trim())
        break
      }
      // unknown block type → skip (mechanical: lossy-but-complete)
    }
  }
  return chunks
}

export function presentationJsonToOutline(doc: unknown, opts: OutlineOpts = {}): OutlineResult {
  const d = (doc ?? {}) as { metadata?: { title?: string }; sections?: Array<{ title?: string; slides?: Block[] }> }
  const title = (opts.title || d.metadata?.title || 'Untitled').trim() || 'Untitled'
  const ocrBySrc = opts.ocrBySrc ?? {}
  const assets: string[] = []

  const parts: string[] = []
  parts.push(`---\ntitle: ${JSON.stringify(title)}\nauthor: ""\norigin: external\n---`)
  parts.push(`# ${title}`)

  for (const section of d.sections ?? []) {
    const st = (section.title ?? '').trim()
    if (st) parts.push(`## ${st}`)
    ;(section.slides ?? []).forEach((slide, i) => {
      const s = slide as { order?: number; title?: string; notes?: string; content?: Block[] }
      const order = typeof s.order === 'number' ? s.order : i
      const content = s.content ?? []
      // The slide title is stored twice (slide.title AND a leading heading level 1). Use
      // slide.title; adopt the leading heading only when there's no slide.title; strip it from
      // the body either way so it never prints twice.
      let heading = (s.title ?? '').trim()
      let body = content
      const first = content[0]
      if (first && first.type === 'heading' && Number(first.level) === 1) {
        if (!heading) heading = ((first.text as string) ?? '').trim()
        body = content.slice(1)
      }
      if (!heading) heading = `Slide ${order + 1}`

      const chunks = [`### ${heading}`, ...renderBlocks(body, assets, ocrBySrc)]
      const notes = (s.notes ?? '').trim()
      if (notes) chunks.push(`:::notes\n${notes}\n:::`)
      parts.push(chunks.join('\n\n'))
    })
  }

  const seen = new Set<string>()
  const uniqueAssets = assets.filter((a) => (seen.has(a) ? false : (seen.add(a), true)))
  return { markdown: parts.join('\n\n') + '\n', assets: uniqueAssets }
}

/** The not-mine abstract stub written beside the Outline — self-documents third-party origin. */
export function buildAbstract(a: { title: string; sourcePptx: string; date: string }): string {
  return [
    '---',
    `title: ${JSON.stringify(a.title)}`,
    'author: ""',
    `source_pptx: ${JSON.stringify(a.sourcePptx)}`,
    `imported: ${a.date}`,
    'imported_by: slidewell-convert',
    'origin: external',
    '---',
    '',
    '(Converted mechanically from a third-party PPTX. Not authored by you.)',
    ''
  ].join('\n')
}
