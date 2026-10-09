import { describe, it, expect } from 'vitest'
import { extractTalkRefs, poolIdOf } from '../src/main/talk-refs'

describe('poolIdOf', () => {
  it('reads the pool id from a bare id, a legacy double prefix, a path or a URL-encoded path', () => {
    expect(poolIdOf('img-0a5f1b5')).toBe('0a5f1b5')
    expect(poolIdOf('img-img-63c4e31')).toBe('63c4e31')
    expect(poolIdOf('assets/img-9c8057e.png')).toBe('9c8057e')
    expect(poolIdOf('<../_assets/img-9C8057E.webp>')).toBe('9c8057e')
    expect(poolIdOf('assets/folder%20x/img-9c8057e.webp?v=2')).toBe('9c8057e')
  })
  it('ignores other files and remote images', () => {
    expect(poolIdOf('assets/Pasted%20image%2020260101.png')).toBeNull()
    expect(poolIdOf('https://example.com/img-123.png')).toBeNull()
    expect(poolIdOf('vid-4e8ba04')).toBeNull()
    expect(poolIdOf('chime.mp3')).toBeNull()
  })
})

describe('extractTalkRefs: syntaxes', () => {
  const one = (md: string) => extractTalkRefs(`### S\n${md}\n`).refs.map((r) => r.id)
  it('Markdown, with alt text, a title and angle brackets', () => {
    expect(one('![alt](img-aaaaaaa)')).toEqual(['aaaaaaa'])
    expect(one('![alt](assets/img-aaaaaaa.png "caption")')).toEqual(['aaaaaaa'])
    expect(one('![alt](<../_assets/img-aaaaaaa.webp>)')).toEqual(['aaaaaaa'])
    expect(one('![](img-img-aaaaaaa)')).toEqual(['aaaaaaa'])
  })
  it('Obsidian embeds, with a folder and a size', () => {
    expect(one('![[img-aaaaaaa]]')).toEqual(['aaaaaaa'])
    expect(one('![[_assets/img-aaaaaaa.webp|300]]')).toEqual(['aaaaaaa'])
  })
  it('HTML img with either quote style', () => {
    expect(one('<img src="img-aaaaaaa.webp" alt="">')).toEqual(['aaaaaaa'])
    expect(one("<img class='x' src='../_assets/img-aaaaaaa.png'>")).toEqual(['aaaaaaa'])
  })
  it('directive attributes in braces', () => {
    expect(one('{image=img-aaaaaaa}')).toEqual(['aaaaaaa'])
    expect(one('{layout=hero bg="img-aaaaaaa"}')).toEqual(['aaaaaaa'])
  })
  it('several on one line, and the same image twice on one slide counts once', () => {
    expect(one('![](img-aaaaaaa) ![](img-bbbbbbb) ![](img-aaaaaaa)')).toEqual(['aaaaaaa', 'bbbbbbb'])
  })
  it('does not match video, audio, remote images or prose', () => {
    expect(one('![](vid-aaaaaaa)\n![](chime.mp3)\n![](https://example.com/a.png)\nsee img-aaaaaaa in the pool')).toEqual([])
  })
  it('ignores fenced code', () => {
    expect(one('```md\n![](img-aaaaaaa)\n```\n![](img-bbbbbbb)')).toEqual(['bbbbbbb'])
  })
  it('reads frontmatter values', () => {
    const t = extractTalkRefs('---\ntitle: T\ncover: img-aaaaaaa\n---\n### S\n')
    expect(t.refs).toEqual([{ id: 'aaaaaaa', slide: 1 }])
  })
})

describe('extractTalkRefs: slide numbers and title', () => {
  const talk = [
    '---', 'title: Sample talk', '---', '',
    '# Sample talk', '', '## Part one', '',
    '### First', '![](img-aaaaaaa)', '',
    '### Second', '![](img-bbbbbbb)', '',
    '```', '### not a heading', '```', '',
    '### Third', '![](img-aaaaaaa)'
  ].join('\n')
  it('counts a generated title slide, then every heading of level 1 to 3', () => {
    expect(extractTalkRefs(talk).refs).toEqual([
      { id: 'aaaaaaa', slide: 4 },
      { id: 'bbbbbbb', slide: 5 },
      { id: 'aaaaaaa', slide: 6 }
    ])
  })
  it('has no title slide when auto_title_slide is off or the talk opens explicitly', () => {
    expect(extractTalkRefs(talk.replace('title: Sample talk', 'title: Sample talk\nauto_title_slide: false')).refs[0].slide).toBe(3)
    expect(extractTalkRefs('### Open {role=opening}\n![](img-aaaaaaa)').refs[0].slide).toBe(1)
  })
  it('puts a reference above the first heading on slide 1', () => {
    expect(extractTalkRefs('![](img-aaaaaaa)\n### A').refs).toEqual([{ id: 'aaaaaaa', slide: 1 }])
  })
  it('takes the title from frontmatter, else the first heading, else empty', () => {
    expect(extractTalkRefs(talk).title).toBe('Sample talk')
    expect(extractTalkRefs('# Heading title {id=x}\n').title).toBe('Heading title')
    expect(extractTalkRefs('no headings').title).toBe('')
  })
  it('copes with CRLF and an empty file', () => {
    expect(extractTalkRefs('### A\r\n![](img-aaaaaaa)\r\n').refs).toEqual([{ id: 'aaaaaaa', slide: 2 }])
    expect(extractTalkRefs('')).toEqual({ title: '', refs: [] })
  })
})
