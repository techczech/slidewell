// Generate build/icon.icns from an inline SVG (run: node build/make-icon.mjs).
// Uses the project's bundled sharp to rasterize, then macOS iconutil to pack the .icns.
// Placeholder mark — swap the SVG for a designed icon any time and re-run.
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const iconset = join(here, 'icon.iconset')

// SlideWell: a stack of slides drawn from a well, in the app's Oxford-blue + claret palette.
const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12508f"/><stop offset="1" stop-color="#0b3a6b"/>
    </linearGradient>
  </defs>
  <rect x="56" y="56" width="912" height="912" rx="208" fill="url(#bg)"/>
  <rect x="316" y="232" width="392" height="248" rx="26" fill="#0b3a6b" stroke="#5b86b8" stroke-width="6"/>
  <rect x="286" y="330" width="452" height="286" rx="30" fill="#efe6d6" opacity="0.9"/>
  <rect x="248" y="436" width="528" height="332" rx="36" fill="#fffdf8"/>
  <circle cx="512" cy="602" r="58" fill="#9f1239"/>
</svg>`
const buf = Buffer.from(svg)

const sizes = [16, 32, 64, 128, 256, 512, 1024]
const names = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png']
}

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const s of sizes) {
  const png = await sharp(buf).resize(s, s).png().toBuffer()
  for (const n of names[s]) writeFileSync(join(iconset, n), png)
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(here, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
// also a 512 PNG for the website / any non-mac use
writeFileSync(join(here, 'icon.png'), await sharp(buf).resize(512, 512).png().toBuffer())
console.log('wrote build/icon.icns + build/icon.png')
