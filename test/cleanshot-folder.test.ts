import { describe, it, expect } from 'vitest'
import { cleanShotFolder, normaliseExportPath } from '../src/main/cleanshot-folder'

describe('cleanShotFolder', () => {
  it('returns the folder the reader gives when it exists', async () => {
    expect(await cleanShotFolder(async () => '/Volumes/Data/Shots\n', () => true)).toBe('/Volumes/Data/Shots')
  })
  it('is null when the setting is missing, the reader fails, or the folder is gone', async () => {
    expect(await cleanShotFolder(async () => null, () => true)).toBeNull()
    expect(await cleanShotFolder(async () => { throw new Error('x') }, () => true)).toBeNull()
    expect(await cleanShotFolder(async () => '/nope', () => false)).toBeNull()
  })
  it('accepts file URLs', () => {
    expect(normaliseExportPath('file:///Volumes/Data/My%20Shots/')).toBe('/Volumes/Data/My Shots')
  })
})

describe('changing CleanShot export folder (fake writer only)', () => {
  it('shows the exact command and argv', async () => {
    const { exportPathWriteArgs, exportPathCommand } = await import('../src/main/cleanshot-folder')
    expect(exportPathWriteArgs('/V/My Shots')).toEqual(['write', 'pl.maketheweb.cleanshotx', 'exportPath', '-string', '/V/My Shots'])
    expect(exportPathCommand('/V/My Shots')).toBe("defaults write pl.maketheweb.cleanshotx exportPath -string '/V/My Shots'")
    expect(exportPathCommand("/V/Dom's")).toBe("defaults write pl.maketheweb.cleanshotx exportPath -string '/V/Dom'\\''s'")
  })
  it('reports whether CleanShot already saves to the target', async () => {
    const { cleanShotSetting } = await import('../src/main/cleanshot-folder')
    expect(await cleanShotSetting('/V/Shots', async () => '/V/Shots/')).toMatchObject({ current: '/V/Shots', matches: true })
    expect(await cleanShotSetting('/V/Shots', async () => null)).toMatchObject({ current: null, matches: false })
  })
  it('writes through the injected writer and confirms by reading back', async () => {
    const { setCleanShotExportPath } = await import('../src/main/cleanshot-folder')
    let stored: string | null = '/Old'
    const written: string[] = []
    const r = await setCleanShotExportPath('/V/Shots', async (p) => (written.push(p), (stored = p), true), async () => stored)
    expect(written).toEqual(['/V/Shots'])
    expect(r).toMatchObject({ ok: true, current: '/V/Shots' })
    const failed = await setCleanShotExportPath('/V/Shots', async () => false, async () => '/Old')
    expect(failed.ok).toBe(false)
  })
})

describe('CleanShot name template (fake reader only)', () => {
  // `defaults read pl.maketheweb.cleanshotx mediaNameTemplate` on Dominik's Mac, 2026-10-10
  const HIS_RAW = `(
    "CleanShot ",
    "%y",
    "-",
    "%m",
    "-",
    "%d",
    " at ",
    "%H",
    "%M",
    "from ",
    "%a",
    " with ",
    "%t"
)`

  it('parses the array defaults prints', async () => {
    const { parseDefaultsArray } = await import('../src/main/cleanshot-folder')
    expect(parseDefaultsArray(HIS_RAW)).toEqual(['CleanShot ', '%y', '-', '%m', '-', '%d', ' at ', '%H', '%M', 'from ', '%a', ' with ', '%t'])
    expect(parseDefaultsArray('(\n    Shot,\n    "%y",\n    "a \\"b\\" \\U2014 c\\\\"\n)')).toEqual(['Shot', '%y', 'a "b" — c\\'])
    expect(parseDefaultsArray('()')).toEqual([])
    expect(parseDefaultsArray('CleanShot %y')).toBeNull()
    expect(parseDefaultsArray('( "unterminated )')).toBeNull()
    expect(parseDefaultsArray(null)).toBeNull()
  })

  it('compiles his template through the injected reader; null when unset or failing', async () => {
    const { cleanShotNameTemplate } = await import('../src/main/cleanshot-folder')
    const { parseScreenshotName } = await import('../src/main/screenshot-name')
    const tpl = await cleanShotNameTemplate(async () => HIS_RAW)
    expect(parseScreenshotName('CleanShot 2026-10-10 at 1147from TalkWeaver with TalkWeaver.png', tpl)).toMatchObject({ app: 'TalkWeaver', window: 'TalkWeaver' })
    expect(await cleanShotNameTemplate(async () => null)).toBeNull()
    expect(await cleanShotNameTemplate(async () => { throw new Error('no defaults') })).toBeNull()
  })
})
