import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderPath, slideStructure } from '../src/main/archive'

// Fixture archive laid out the way ppt-archive's tools/renders writes it:
// extracted/<id>/renders/slide_NNNN.webp (NNNN = 1-based page) + renders.json (slide_order → page).
let root: string
const renders = (id: string): string => join(root, 'extracted', id, 'renders')

function deck(id: string, orders: number[], manifest: boolean): void {
  mkdirSync(renders(id), { recursive: true })
  orders.forEach((_, i) => writeFileSync(join(renders(id), `slide_${String(i + 1).padStart(4, '0')}.webp`), ''))
  if (manifest) {
    const entries = orders.map((order, i) => ({ slide_order: order, page: i + 1, render: `renders/slide_${String(i + 1).padStart(4, '0')}.webp` }))
    writeFileSync(join(root, 'extracted', id, 'renders.json'), JSON.stringify({ presentation_id: id, renders: entries }))
  }
  const slides = orders.map((order) => ({ order, title: `slide with order ${order}` }))
  writeFileSync(join(root, 'extracted', id, 'presentation.json'), JSON.stringify({ sections: [{ slides }] }))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sw-render-'))
  deck('one-based', [1, 2, 3], true) // the extractor's normal numbering
  deck('no-manifest', [1, 2, 3], false) // renders present, renders.json missing
  deck('zero-based', [0, 1, 2], true) // a few older extractions number from 0
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('renderPath', () => {
  it('slide order N (numbered from 1) → its own render, slide_000N.webp', () => {
    expect(renderPath(root, 'one-based', 1)).toBe(join(renders('one-based'), 'slide_0001.webp'))
    expect(renderPath(root, 'one-based', 2)).toBe(join(renders('one-based'), 'slide_0002.webp'))
  })
  it('the last slide has a render (not "no render")', () => {
    expect(renderPath(root, 'one-based', 3)).toBe(join(renders('one-based'), 'slide_0003.webp'))
  })
  it('without renders.json, uses the extractor convention page == slide order', () => {
    expect(renderPath(root, 'no-manifest', 1)).toBe(join(renders('no-manifest'), 'slide_0001.webp'))
    expect(renderPath(root, 'no-manifest', 3)).toBe(join(renders('no-manifest'), 'slide_0003.webp'))
  })
  it('a zero-based deck follows its manifest (order 0 → page 1)', () => {
    expect(renderPath(root, 'zero-based', 0)).toBe(join(renders('zero-based'), 'slide_0001.webp'))
    expect(renderPath(root, 'zero-based', 2)).toBe(join(renders('zero-based'), 'slide_0003.webp'))
  })
  it('null order / unknown deck → null', () => {
    expect(renderPath(root, 'one-based', null)).toBeNull()
    expect(renderPath(root, 'missing', 1)).toBeNull()
  })
})

describe('slideStructure', () => {
  it('returns the node whose order matches, not the next one', () => {
    expect(JSON.parse(slideStructure(root, 'one-based', 1) ?? '{}').order).toBe(1)
    expect(JSON.parse(slideStructure(root, 'zero-based', 0) ?? '{}').order).toBe(0)
  })
})
