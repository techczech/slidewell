import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyMacDownload } from '../src/main/update-engine'

const bundleId = 'net.dominiklukes.slidewell'
const team = 'M7H45AGG8A'

describe('downloaded SlideWell trust', () => {
  it.skipIf(process.platform !== 'darwin')('refuses a genuinely ad hoc-signed bundle with the correct plist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sw-trust-'))
    const bundle = join(root, 'Disposable.app')
    const contents = join(bundle, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    copyFileSync('/usr/bin/true', join(contents, 'MacOS', 'fixture'))
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundleId}</string>
      <key>CFBundleShortVersionString</key><string>1.1.0</string>
      <key>CFBundleExecutable</key><string>fixture</string>
      <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>`)
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' })
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    const zip = join(root, 'fixture.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip])
    const offer = { bundleId, version: '1.1.0', released: '2026-11-22', size: statSync(zip).size, sha512: '', url: '' }
    expect(await verifyMacDownload(zip, offer, '1.0.0')).toBe('signature')
  })

  it('checks the pinned team and rejects a bundle whose codesign assessment fails', async () => {
    const observed: string[][] = []
    const { verifyBundleTrust } = await import('../src/main/update-trust')
    const verdict = await verifyBundleTrust('/tmp/fake-wrong-team.app', { bundleId, team }, async (tool, args) => {
      observed.push([tool, ...args])
      if (tool === '/usr/bin/codesign') throw new Error('does not satisfy its specified requirement')
    })
    expect(verdict).toBe('signature')
    expect(observed).toEqual([['/usr/bin/codesign', '--verify', '--deep', '--strict',
      '-R', `identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
      '/tmp/fake-wrong-team.app']])
  })
})
