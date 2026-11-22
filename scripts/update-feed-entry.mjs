import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const assetName = 'SlideWell-mac-arm64.zip'
const number = '(?:0|[1-9][0-9]{0,5})'
const versionPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-alpha\\.${number})?$`)

async function main([mode, version, asset, entry, ...extra]) {
  if (!['write', 'check'].includes(mode) || !versionPattern.test(version ?? '') ||
    !asset || basename(asset) !== assetName || !entry || extra.length) {
    throw new Error(`Usage: node scripts/update-feed-entry.mjs write|check <version> <${assetName}> <entry.json>`)
  }

  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(asset)) {
    size += chunk.length
    hash.update(chunk)
  }
  if (size === 0 || size > 4 * 1024 ** 3) throw new Error('The update ZIP is empty or exceeds the feed size limit.')
  const expected = {
    version,
    update: { mac: {
      url: `https://github.com/techczech/slidewell/releases/download/v${version}/${assetName}`,
      size,
      sha512: hash.digest('base64'),
      bundleId: 'net.dominiklukes.slidewell'
    } }
  }

  if (mode === 'write') {
    await writeFile(entry, JSON.stringify(expected, null, 2) + '\n', { flag: 'wx' })
    return
  }
  const parsed = JSON.parse(await readFile(entry, 'utf8'))
  const candidate = parsed.schema === 1
    ? parsed.channels?.[version.includes('-alpha.') ? 'alpha' : 'release']
    : parsed
  const mac = candidate?.update?.mac
  if (candidate?.version !== version || !mac ||
    Object.entries(expected.update.mac).some(([key, value]) => mac[key] !== value)) {
    throw new Error(`The feed entry for ${version} does not match ${assetName}.`)
  }
  console.log(`Verified ${assetName} for ${version} (${size} bytes)`)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
