import { describe, it, expect } from 'vitest'
import { extractTalkRefs, poolIdOf, classifyTarget } from '../src/main/talk-refs'

describe('poolIdOf', () => {
  it('reads the pool id from a bare id, a legacy double prefix, or an _assets path', () => {
    expect(poolIdOf('img-0a5f1b5')).toBe('0a5f1b5')
    expect(poolIdOf('img-img-63c4e31')).toBe('63c4e31')
    expect(poolIdOf('_assets/img-9c8057e.png')).toBe('9c8057e')
    expect(poolIdOf('<../_assets/img-9C8057E.webp>')).toBe('9c8057e')
    expect(poolIdOf('../../_assets/img-9c8057e.webp?v=2')).toBe('9c8057e')
  })
  it('rejects URLs, other folders and other files', () => {
    expect(poolIdOf('https://example.com/img-9c8057e.png')).toBeNull()
    expect(poolIdOf('https://example.com/_assets/img-9c8057e.png')).toBeNull()
    expect(poolIdOf('//cdn.example.com/_assets/img-9c8057e.png')).toBeNull()
    expect(poolIdOf('file:///x/_assets/img-9c8057e.png')).toBeNull()
    expect(poolIdOf('assets/img-9c8057e.png')).toBeNull()
    expect(poolIdOf('img-9c8057e.webp')).toBeNull() // beside the talk, not the pool
    expect(poolIdOf('assets/Pasted%20image.png')).toBeNull()
    expect(poolIdOf('vid-4e8ba04')).toBeNull()
  })
  it('names a pool-named file kept elsewhere as local', () => {
    expect(classifyTarget('assets/img-9c8057e.png')).toEqual({ id: '9c8057e', via: 'local' })
  })
})

describe('extractTalkRefs: what counts as a reference (compiler image syntax)', () => {
  const ids = (md: string, o = {}) => extractTalkRefs(`## S\n${md}\n`, o).refs.map((r) => r.id)
  it('whole-line Markdown images, with alt, title, angle brackets and attributes', () => {
    expect(ids('![alt](img-aaaaaaa)')).toEqual(['aaaaaaa'])
    expect(ids('![alt](img-aaaaaaa "caption")')).toEqual(['aaaaaaa'])
    expect(ids('![](img-img-aaaaaaa){fit=cover}')).toEqual(['aaaaaaa'])
    expect(ids('![alt](<../_assets/img-aaaaaaa.webp>)')).toEqual(['aaaaaaa'])
    expect(ids('![alt](../_assets/img-aaaaaaa.webp)')).toEqual(['aaaaaaa'])
  })
  it('the same image twice on one slide counts once', () => {
    expect(ids('![](img-aaaaaaa)\n![](img-bbbbbbb)\n![](img-aaaaaaa)')).toEqual(['aaaaaaa', 'bbbbbbb'])
  })
  it('does not count HTML, Obsidian embeds, brace attributes, prose or text around the image', () => {
    expect(ids('<img src="img-aaaaaaa.webp">\n![[img-aaaaaaa]]\n{id=img-aaaaaaa}\nsee img-aaaaaaa\ntext ![](img-aaaaaaa) text')).toEqual([])
  })
  it('does not count video, audio, remote URLs or a talk\'s own assets folder', () => {
    expect(ids('![](vid-aaaaaaa)\n![](chime.mp3)\n![](https://example.com/_assets/img-aaaaaaa.webp)\n![](assets/img-aaaaaaa.png)')).toEqual([])
  })
  it('counts the talk\'s own assets folder only when asked', () => {
    expect(ids('![](assets/img-aaaaaaa.png)', { includeTalkAssets: true })).toEqual(['aaaaaaa'])
  })
  it('ignores fenced code, :::notes, HTML comments and the preamble above the first ## heading', () => {
    expect(ids('```md\n![](img-aaaaaaa)\n```\n~~~\n![](img-aaaaaaa)\n~~~\n<!-- ![](img-aaaaaaa) -->\n:::notes\n![](img-aaaaaaa)\n:::\n![](img-bbbbbbb)')).toEqual(['bbbbbbb'])
    expect(extractTalkRefs('![](img-aaaaaaa)\n# Title\n![](img-aaaaaaa)\n## A\n').refs).toEqual([])
  })
  it('a heading ends an unterminated notes block', () => {
    expect(extractTalkRefs('## A\n:::notes\n## B\n![](img-aaaaaaa)').refs).toEqual([{ id: 'aaaaaaa', slide: 3 }])
  })
})

describe('extractTalkRefs: slide numbers (14-outline-tree.mjs / 08-source-adapters.mjs)', () => {
  const talk = [
    '---', 'title: Sample talk', '---', '',
    '# Sample talk', '', '## Part one', '',
    '### First', '![](img-aaaaaaa)', '',
    '### Second', '![](img-bbbbbbb)', '',
    '```', '### not a heading', '```', '',
    '#### Deeper', '![](img-aaaaaaa)'
  ].join('\n')
  it('# is the talk title, not a slide: cover, then every ## to ###### heading', () => {
    expect(extractTalkRefs(talk).refs).toEqual([
      { id: 'aaaaaaa', slide: 3 },
      { id: 'bbbbbbb', slide: 4 },
      { id: 'aaaaaaa', slide: 5 }
    ])
  })
  it('a title then ### First is slide 2 (cover, First)', () => {
    expect(extractTalkRefs('# Talk\n### First\n![](img-aaaaaaa)').refs).toEqual([{ id: 'aaaaaaa', slide: 2 }])
  })
  it('has no title slide when auto_title_slide is off (false, no, off, hide, 0), quoted or not', () => {
    for (const v of ['false', '"false"', 'no', 'off', 'hide', '0']) {
      expect(extractTalkRefs(`---\nauto_title_slide: ${v}\n---\n### A\n![](img-aaaaaaa)`).refs[0].slide).toBe(1)
    }
    expect(extractTalkRefs('---\nauto_title_slide: true\n---\n### A\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
  })
  it('an explicit {role=opening} on a heading or its trigger line replaces the generated title slide', () => {
    expect(extractTalkRefs('### Open {role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
    expect(extractTalkRefs('### Open\n{role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
  })
  it('{role=opening} in fenced code, notes-free prose or a later content line does not', () => {
    expect(extractTalkRefs('### A\n```\n{role=opening}\n```\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
    expect(extractTalkRefs('### A\n\ntext\n{role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
  })
})

describe('extractTalkRefs: title and odd input', () => {
  it('takes the title from frontmatter, else the # heading, else empty', () => {
    expect(extractTalkRefs('---\ntitle: From front\n---\n# Heading\n').title).toBe('From front')
    expect(extractTalkRefs('# Heading title {id=x}\n').title).toBe('Heading title')
    expect(extractTalkRefs('## no title heading').title).toBe('')
  })
  it('copes with CRLF and an empty file', () => {
    expect(extractTalkRefs('### A\r\n![](img-aaaaaaa)\r\n').refs).toEqual([{ id: 'aaaaaaa', slide: 2 }])
    expect(extractTalkRefs('')).toEqual({ title: '', refs: [] })
  })
})
