import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('writes the entry from the ZIP and detects changed bytes on a fresh download', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sw-feed-'))
  const asset = join(scratch, 'SlideWell-mac-arm64.zip')
  const entry = join(scratch, 'update-entry.json')
  const version = '1.2.3-alpha.10'
  const original = Buffer.from('fixture ZIP bytes')
  writeFileSync(asset, original)
  const args = (mode: string) => ['scripts/update-feed-entry.mjs', mode, version, asset, entry]
  execFileSync(process.execPath, args('write'))
  expect(JSON.parse(readFileSync(entry, 'utf8'))).toEqual({
    version,
    update: { mac: {
      url: `https://github.com/techczech/slidewell/releases/download/v${version}/SlideWell-mac-arm64.zip`,
      size: original.length,
      sha512: createHash('sha512').update(original).digest('base64'),
      bundleId: 'net.dominiklukes.slidewell'
    } }
  })
  expect(spawnSync(process.execPath, args('check')).status).toBe(0)
  writeFileSync(asset, Buffer.alloc(original.length, 1))
  expect(spawnSync(process.execPath, args('check')).status).toBe(1)
})
