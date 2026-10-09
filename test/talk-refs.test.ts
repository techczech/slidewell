import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  it('a talk-local copy is exactly assets/img-<hex>.<image ext> beside the outline, optionally ./assets/', () => {
    expect(classifyTarget('assets/img-9c8057e.png')).toEqual({ id: '9c8057e', via: 'local' })
    expect(classifyTarget('./assets/img-9C8057E.webp')).toEqual({ id: '9c8057e', via: 'local' })
    expect(classifyTarget('<assets/img-9c8057e.jpeg>')).toEqual({ id: '9c8057e', via: 'local' })
  })
  it('any other path with a pool-like file name is neither pool nor local copy', () => {
    for (const no of ['unrelated/img-aaaaaaa.png', '../assets/img-aaaaaaa.png', 'assets/sub/img-aaaaaaa.png', 'other/assets/img-aaaaaaa.png',
      'assets/img-aaaaaaa.txt', 'assets/img-aaaaaaa', 'img-aaaaaaa.png', '/assets/img-aaaaaaa.png', 'assets\\img-aaaaaaa.png']) expect(classifyTarget(no)).toBeNull()
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
  it('counts the talk\'s own assets copy only when its id is in the pool passed in', () => {
    const pool = new Set(['aaaaaaa'])
    expect(extractTalkRefs('## S\n![](assets/img-aaaaaaa.png)\n', { pool }).refs).toEqual([{ id: 'aaaaaaa', slide: 2, via: 'local' }])
    expect(extractTalkRefs('## S\n![](assets/img-bbbbbbb.png)\n', { pool }).refs).toEqual([])
    expect(extractTalkRefs('## S\n![](unrelated/img-aaaaaaa.png)\n', { pool }).refs).toEqual([])
  })
  it('filters before de-duplicating: a rejected copy does not hide a later reference on the same slide', () => {
    const pool = new Set(['aaaaaaa'])
    expect(extractTalkRefs('## S\n![](assets/img-bbbbbbb.png)\n![](img-bbbbbbb)\n', { pool }).refs).toEqual([{ id: 'bbbbbbb', slide: 2, via: 'pool' }])
    // a valid copy and a pool reference to the same image on one slide are one row
    expect(extractTalkRefs('## S\n![](assets/img-aaaaaaa.png)\n![](img-aaaaaaa)\n', { pool }).refs).toHaveLength(1)
  })
  it('ignores fenced code, :::notes, HTML comments and the preamble above the first ## heading', () => {
    expect(ids('```md\n![](img-aaaaaaa)\n```\n~~~\n![](img-aaaaaaa)\n~~~\n<!-- ![](img-aaaaaaa) -->\n:::notes\n![](img-aaaaaaa)\n:::\n![](img-bbbbbbb)')).toEqual(['bbbbbbb'])
    expect(extractTalkRefs('![](img-aaaaaaa)\n# Title\n![](img-aaaaaaa)\n## A\n').refs).toEqual([])
  })
  it('a heading ends an unterminated notes block', () => {
    expect(extractTalkRefs('## A\n:::notes\n## B\n![](img-aaaaaaa)').refs).toEqual([{ id: 'aaaaaaa', slide: 3, via: 'pool' }])
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
      { id: 'aaaaaaa', slide: 3, via: 'pool' },
      { id: 'bbbbbbb', slide: 4, via: 'pool' },
      { id: 'aaaaaaa', slide: 5, via: 'pool' }
    ])
  })
  it('a title then ### First is slide 2 (cover, First)', () => {
    expect(extractTalkRefs('# Talk\n### First\n![](img-aaaaaaa)').refs).toEqual([{ id: 'aaaaaaa', slide: 2, via: 'pool' }])
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
  it('{role=opening} in fenced code, in notes or above the first ## does not', () => {
    expect(extractTalkRefs('### A\n```\n{role=opening}\n```\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
    expect(extractTalkRefs('### A\n:::notes\n{role=opening}\n:::\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
    expect(extractTalkRefs('{role=opening}\n# T\n### A\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
  })
  // Expected numbers below were produced by TalkWeaver's compiler itself (adaptMarkdownOutlineV2,
  // 08-source-adapters.mjs) on the same Markdown, then pinned here.
  it('a stray Trigger line later in the body still sets the role (contentLinesAndAttrs folds it in)', () => {
    expect(extractTalkRefs('### A\n\ntext\n{role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
  })
  it('the last role token wins: heading, then Trigger block, then stray Trigger lines', () => {
    // `## Start {role=opening}` overridden by `{role=content}`: content slide, title slide still generated
    const overridden = '# Two\n## Start {role=opening}\n{role=content}\n![](img-aaaaaaa)\n\n## Next\n![](img-bbbbbbb)\n'
    expect(extractTalkRefs(overridden).refs.map((r) => r.slide)).toEqual([2, 3])
    expect(extractTalkRefs('## S {role=content}\n{role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
    expect(extractTalkRefs('## A\n{role=opening}\n{role=content}\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
    expect(extractTalkRefs('## A\n{role=opening}\n\n{role=content}\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
    expect(extractTalkRefs('## A\n{role=content}\n\n{role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
    expect(extractTalkRefs('## A {role="opening"}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
    expect(extractTalkRefs('## A {role:opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
    expect(extractTalkRefs('## A {role=opening}{role=foo}\n![](img-aaaaaaa)').refs[0].slide).toBe(2)
  })
  it('the role-precedence fixture talk matches the compiler', () => {
    const md = readFileSync(join(__dirname, 'fixtures', 'role-precedence-outline.md'), 'utf8')
    // compiler: 1 generated title slide, 2 start (content), 3 middle, 4 later (content), 5 generated thanks slide
    expect(extractTalkRefs(md).refs).toEqual([
      { id: 'aaaaaaa', slide: 2, via: 'pool' },
      { id: 'bbbbbbb', slide: 3, via: 'pool' },
      { id: 'ccccccc', slide: 4, via: 'pool' }
    ])
  })
})

describe('extractTalkRefs: a slide number is kept only when it is certain (else 0)', () => {
  // Each case was compiled by TalkWeaver's compiler (adaptMarkdownOutlineV2); its numbers are in the
  // comments. Every number kept here equals the compiler's; 0 marks where the compiler's numbering
  // can depart from one-slide-per-heading.
  const nums = (md: string): string[] => extractTalkRefs(md).refs.map((r) => `${r.id[0]}@${r.slide}`)
  const long = 'word '.repeat(400).trim()
  it('a fold token on a heading with children makes that slide and later ones unknown', () => {
    // compiler: a@2 b@3 d@3 c@4 (the children fold into slide 3)
    expect(nums('## A\n![](img-aaaaaaa)\n## B {image-grid}\n### c\n![](img-bbbbbbb)\n### d\n![](img-ddddddd)\n## E\n![](img-ccccccc)\n')).toEqual(['a@2', 'b@0', 'd@0', 'c@0'])
    // compiler: a@2 c@4 ({2col} on the Trigger line)
    expect(nums('## A\n![](img-aaaaaaa)\n## B\n{2col}\n### c\nx\n### d\ny\n## E\n![](img-ccccccc)\n')).toEqual(['a@2', 'c@0'])
  })
  it('a fold token on a heading without children changes nothing', () => {
    // compiler: a@2 b@3 c@4
    expect(nums('## A\n![](img-aaaaaaa)\n## B {image-grid}\n![](img-bbbbbbb)\n## E\n![](img-ccccccc)\n')).toEqual(['a@2', 'b@3', 'c@4'])
  })
  it('a quote-only slide may split into continuations; a quote beside an image does not', () => {
    // compiler: a@2 c@13 (the quote became ten slides)
    expect(nums(`## A\n![](img-aaaaaaa)\n## Q\n> ${long}\n## E\n![](img-ccccccc)\n`)).toEqual(['a@2', 'c@0'])
    // compiler: a@2 b@3 c@4
    expect(nums(`## A\n![](img-aaaaaaa)\n## Q\n> ${long}\n![](img-bbbbbbb)\n## E\n![](img-ccccccc)\n`)).toEqual(['a@2', 'b@3', 'c@4'])
  })
  it('a timeline-only slide may split, so later numbers are unknown', () => {
    const stops = Array.from({ length: 14 }, (_, i) => `- ${2000 + i} — event ${i}`).join('\n')
    // compiler: a@2 c@4 (under the cap this time; a longer one splits)
    expect(nums(`## A\n![](img-aaaaaaa)\n## T\n**Timeline:**\n${stops}\n## E\n![](img-ccccccc)\n`)).toEqual(['a@2', 'c@0'])
  })
  it('an authored opening below a ## section: unknown from that section on, certain before it', () => {
    // compiler: d@1 a@2 b@4 c@5 (the section divider moved after the opening)
    expect(nums('## Z\n![](img-ddddddd)\n## P\n### A {role=opening}\n![](img-aaaaaaa)\n### B\n![](img-bbbbbbb)\n## E\n![](img-ccccccc)\n')).toEqual(['d@1', 'a@0', 'b@0', 'c@0'])
  })
  it('talk-wide triggers apply to every heading', () => {
    // compiler: a@2 c@4
    expect(nums('---\ntriggers: 2col\n---\n## A\n![](img-aaaaaaa)\n## B\n### c\nx\n### d\ny\n## E\n![](img-ccccccc)\n')).toEqual(['a@2', 'c@0'])
  })
  const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
  it('a role in talk-wide triggers makes every number unknown', () => {
    // compiler: a@1 b@2 (every slide is an opening, so no title slide)
    expect(nums(fixture('triggers-role-outline.md'))).toEqual(['a@0', 'b@0'])
  })
  it('a fold token inside a fence under a heading with children counts like an unfenced one', () => {
    // compiler: a@2 c@4 (container-fold resolution reads the fenced {image-grid})
    expect(nums(fixture('fenced-fold-outline.md'))).toEqual(['a@2', 'b@0', 'c@0'])
  })
  it('a {role=opening} on a heading a fold may absorb makes every number unknown', () => {
    // compiler: d@2 a@3 b@3 c@4 (the absorbed opening is ignored: the title slide is still generated)
    expect(nums(fixture('opening-in-fold-outline.md'))).toEqual(['d@0', 'a@0', 'b@0', 'c@0'])
  })
  it('one image on several unknown slides is one reference', () => {
    expect(nums('## B {image-grid}\n### c\n![](img-aaaaaaa)\n### d\n## E\n![](img-aaaaaaa)\n')).toEqual(['a@0'])
  })
})

describe('extractTalkRefs: {compare} keeps only its first two child groups', () => {
  const ids = (md: string): string[] => extractTalkRefs(md).refs.map((r) => r.id[0])
  it('drops the third group and the compare heading\'s own lines, as the compiler does', () => {
    // compiler: a and b on the compare slide, d after it; 0 (own lines) and c are not drawn
    expect(ids(readFileSync(join(__dirname, 'fixtures', 'compare-abc-outline.md'), 'utf8'))).toEqual(['a', 'b', 'd'])
  })
  it('a half keeps what a {columns} half merges in, not what sits under an ordinary half', () => {
    // compiler: a, b and 2 drawn; 1 (under half A) and c (third group) not
    expect(ids('## Versus {compare}\n### A\n![](img-aaaaaaa)\n#### A1\n![](img-1111111)\n### B {2col}\n#### B1\n![](img-bbbbbbb)\n#### B2\n![](img-2222222)\n### C\n![](img-ccccccc)\n')).toEqual(['a', 'b', '2'])
  })
  it('a later layout token undoes the compare: every group is its own slide', () => {
    // compiler: a@3 b@4 c@5
    expect(ids('## Versus {compare}\n{list}\n### A\n![](img-aaaaaaa)\n### B\n![](img-bbbbbbb)\n### C\n![](img-ccccccc)\n')).toEqual(['a', 'b', 'c'])
  })
  it('compare wins in the renderer whatever else the heading carries: {compare cards=grid}, {compare carousel}', () => {
    // compiler: a and b on the compare slide; 0 (own lines) and c not drawn
    expect(ids(readFileSync(join(__dirname, 'fixtures', 'compare-cards-grid-outline.md'), 'utf8'))).toEqual(['a', 'b'])
    expect(ids('## V {compare carousel}\n![](img-0000000)\n### A\n![](img-aaaaaaa)\n### B\n![](img-bbbbbbb)\n### C\n![](img-ccccccc)\n')).toEqual(['a', 'b'])
  })
  it('no discard when the children never reach compare as cards', () => {
    expect(ids('## V {compare}\n### A\n![](img-aaaaaaa)\n')).toEqual(['a']) // one group
    // compiler: 0, a, b, c all drawn ({2col} merges the children into the heading's lines)
    expect(ids('## V {compare 2col}\n![](img-0000000)\n### A\n![](img-aaaaaaa)\n### B\n![](img-bbbbbbb)\n### C\n![](img-ccccccc)\n')).toEqual(['0', 'a', 'b', 'c'])
    // compiler: a, b, c drawn as cards ({compare} only inside a fence: the slide renders as cards)
    expect(ids('## V {cards=grid}\n```\n{compare}\n```\n### A\n![](img-aaaaaaa)\n### B\n![](img-bbbbbbb)\n### C\n![](img-ccccccc)\n')).toEqual(['a', 'b', 'c'])
  })
})

describe('extractTalkRefs: title and odd input', () => {
  it('takes the title from frontmatter, else the # heading, else empty', () => {
    expect(extractTalkRefs('---\ntitle: From front\n---\n# Heading\n').title).toBe('From front')
    expect(extractTalkRefs('# Heading title {id=x}\n').title).toBe('Heading title')
    expect(extractTalkRefs('## no title heading').title).toBe('')
  })
  it('copes with CRLF and an empty file', () => {
    expect(extractTalkRefs('### A\r\n![](img-aaaaaaa)\r\n').refs).toEqual([{ id: 'aaaaaaa', slide: 2, via: 'pool' }])
    expect(extractTalkRefs('')).toEqual({ title: '', refs: [] })
  })
})
