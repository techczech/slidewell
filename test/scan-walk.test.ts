// The Triage source walker skips the backlog import's dated moved folders (scratch folder only).
import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { walk } from '../src/main/scan-walk'
import { isMovedFolderName } from '../src/main/backlog-plan'

const root = join(homedir(), 'Library', 'Caches', 'slidewell-dev-13', `walk-${process.pid}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('Triage source walk', () => {
  it('skips "Moved by SlideWell <date>" folders and dot folders (incl. .slidewell-staging)', () => {
    for (const rel of ['a.png', 'sub/b.png', 'Moved by SlideWell 2026-10-09/a.png', 'Moved by SlideWell notes/c.png', '.hidden/d.png', '.slidewell-staging/e.png.0a1b']) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), 'x')
    }
    const got = [...walk(root)].map((f) => relative(root, f.abs)).sort()
    expect(got).toEqual(['Moved by SlideWell notes/c.png', 'a.png', 'sub/b.png'])
    expect([...walk(root, false)].map((f) => relative(root, f.abs))).toEqual(['a.png'])
  })
  it('isMovedFolderName', () => {
    expect(isMovedFolderName('Moved by SlideWell 2026-10-09')).toBe(true)
    expect(isMovedFolderName('Moved by SlideWell 2026-10-09 copy')).toBe(false)
  })
})
