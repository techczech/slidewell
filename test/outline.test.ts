import { describe, it, expect } from 'vitest'
import { presentationJsonToOutline, buildAbstract, slugify } from '../src/main/outline'

const wrap = (slides: unknown[], sectionTitle = '', meta: Record<string, unknown> = {}) => ({
  version: '2.1',
  metadata: { title: 'My Deck', ...meta },
  sections: [{ title: sectionTitle, slides }]
})

describe('slugify', () => {
  it('lowercases, trims, collapses, replaces non-alphanumerics with hyphens', () => {
    expect(slugify('Their Deck Title!')).toBe('their-deck-title')
    expect(slugify('  Multiple   Spaces ')).toBe('multiple-spaces')
    expect(slugify('weird/chars:here')).toBe('weird-chars-here')
  })
})

describe('presentationJsonToOutline — frontmatter & title', () => {
  it('emits external-stamped frontmatter and a single H1, with no section heading for an unnamed section', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'Intro', content: [{ type: 'heading', text: 'Intro', level: 1 }, { type: 'list', style: 'bullet', items: [{ text: 'one', level: 0 }, { text: 'two', level: 0 }] }] }])
    )
    expect(markdown).toContain('title: "My Deck"')
    expect(markdown).toContain('author: ""')
    expect(markdown).toContain('origin: external')
    expect(markdown).toContain('# My Deck')
    expect(markdown).toContain('### Intro')
    expect(markdown).not.toContain('\n## ') // single unnamed section → no ## heading
    // title not duplicated: the leading level-1 heading block is skipped
    expect((markdown.match(/Intro/g) || []).length).toBe(1)
    expect(markdown).toContain('- one\n- two')
  })

  it('falls back to "Slide N" (1-based from order) when a slide has no title', () => {
    const { markdown } = presentationJsonToOutline(wrap([{ order: 4, content: [] }]))
    expect(markdown).toContain('### Slide 5')
  })

  it('honours an explicit title option over metadata.title', () => {
    const { markdown } = presentationJsonToOutline(wrap([{ order: 0, title: 'X', content: [] }]), { title: 'Override' })
    expect(markdown).toContain('title: "Override"')
    expect(markdown).toContain('# Override')
  })
})

describe('presentationJsonToOutline — lists', () => {
  it('indents by level (2 spaces each) and renders nested children', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'L', content: [{ type: 'list', style: 'bullet', items: [{ text: 'a', level: 0 }, { text: 'b', level: 1 }, { text: 'c', level: 2 }] }] }])
    )
    expect(markdown).toContain('- a\n  - b\n    - c')
  })

  it('renders children arrays at their own level', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'L', content: [{ type: 'list', style: 'bullet', items: [{ text: 'parent', level: 0, children: [{ text: 'child', level: 1 }] }] }] }])
    )
    expect(markdown).toContain('- parent\n  - child')
  })

  it('uses numbered markers for numbered lists', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'N', content: [{ type: 'list', style: 'numbered', items: [{ text: 'first', level: 0 }] }] }])
    )
    expect(markdown).toContain('1. first')
  })

  it('renders inline runs (bold/italic/link)', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'R', content: [{ type: 'list', style: 'bullet', items: [
        { text: 'ignored', level: 0, runs: [{ text: 'bold', bold: true }, { text: ' plain' }] },
        { text: 'ignored', level: 0, runs: [{ text: 'it', italic: true }] },
        { text: 'ignored', level: 0, runs: [{ text: 'link', url: 'http://y' }] }
      ] }] }])
    )
    expect(markdown).toContain('- **bold** plain')
    expect(markdown).toContain('- _it_')
    expect(markdown).toContain('- [link](http://y)')
  })

  it('wraps a whole item in a link when item.url is set (no runs)', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'U', content: [{ type: 'list', style: 'bullet', items: [{ text: 'see this', level: 0, url: 'http://z' }] }] }])
    )
    expect(markdown).toContain('- [see this](http://z)')
  })
})

describe('presentationJsonToOutline — tables, notes, sections', () => {
  it('renders a pipe table with a header separator', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'T', content: [{ type: 'table', has_header: true, rows: [
        [{ text: 'H1', is_header: true }, { text: 'H2', is_header: true }],
        [{ text: 'a' }, { text: 'b' }]
      ] }] }])
    )
    expect(markdown).toContain('| H1 | H2 |\n| --- | --- |\n| a | b |')
  })

  it('renders a notes block from slide.notes', () => {
    const { markdown } = presentationJsonToOutline(wrap([{ order: 0, title: 'Nt', notes: 'speaker note', content: [] }]))
    expect(markdown).toContain(':::notes\nspeaker note\n:::')
  })

  it('emits ## for each named section', () => {
    const doc = { version: '2.1', metadata: { title: 'D' }, sections: [
      { title: 'Alpha', slides: [{ order: 0, title: 's1', content: [] }] },
      { title: 'Beta', slides: [{ order: 1, title: 's2', content: [] }] }
    ] }
    const { markdown } = presentationJsonToOutline(doc)
    expect(markdown).toContain('## Alpha')
    expect(markdown).toContain('## Beta')
  })
})

describe('presentationJsonToOutline — images, smartart, video, links, shapes', () => {
  it('emits an image reference, collects the asset, and inlines OCR only when provided', () => {
    const doc = wrap([{ order: 0, title: 'I', content: [{ type: 'image', src: 'media/deck/slide_0_3.png', alt: 'Picture 3' }] }])
    const plain = presentationJsonToOutline(doc)
    expect(plain.markdown).toContain('![Picture 3](assets/slide_0_3.png)')
    expect(plain.assets).toContain('media/deck/slide_0_3.png')
    expect(plain.markdown).not.toContain('Image text:')

    const withOcr = presentationJsonToOutline(doc, { ocrBySrc: { 'media/deck/slide_0_3.png': 'Hello\nWorld' } })
    expect(withOcr.markdown).toContain('*Image text: Hello; World*')
  })

  it('flattens smart_art nodes into a nested bullet list', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'SA', content: [{ type: 'smart_art', nodes: [
        { text: 'n1', level: 1 },
        { text: 'n2', level: 1, children: [{ text: 'n2a', level: 2 }] }
      ] }] }])
    )
    expect(markdown).toContain('- n1')
    expect(markdown).toContain('- n2')
    expect(markdown).toContain('  - n2a')
  })

  it('renders local video as an asset link and external video as a URL', () => {
    const local = presentationJsonToOutline(wrap([{ order: 0, title: 'V', content: [{ type: 'video', src: 'media/deck/clip.mp4', title: 'Demo' }] }]))
    expect(local.markdown).toContain('[▶ Demo](assets/clip.mp4)')
    expect(local.assets).toContain('media/deck/clip.mp4')

    const ext = presentationJsonToOutline(wrap([{ order: 0, title: 'V', content: [{ type: 'video', src: 'https://youtu.be/x', title: 'Yt' }] }]))
    expect(ext.markdown).toContain('[▶ Yt](https://youtu.be/x)')
    expect(ext.assets).not.toContain('https://youtu.be/x')
  })

  it('renders a link block and keeps shape text but drops decorative shapes', () => {
    const { markdown } = presentationJsonToOutline(
      wrap([{ order: 0, title: 'Mix', content: [
        { type: 'link', text: 'Click', url: 'http://y' },
        { type: 'shape', shape_type: 'rect', text: 'Box label' },
        { type: 'shape', shape_type: 'arrow' }
      ] }])
    )
    expect(markdown).toContain('[Click](http://y)')
    expect(markdown).toContain('Box label')
  })
})

describe('buildAbstract', () => {
  it('stamps the not-mine origin and provenance', () => {
    const md = buildAbstract({ title: 'Their Deck', sourcePptx: 'their-deck.pptx', date: '2026-06-23' })
    expect(md).toContain('title: "Their Deck"')
    expect(md).toContain('origin: external')
    expect(md).toContain('imported_by: slidewell-convert')
    expect(md).toContain('source_pptx: "their-deck.pptx"')
    expect(md).toContain('imported: 2026-06-23')
  })
})
