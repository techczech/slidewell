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
