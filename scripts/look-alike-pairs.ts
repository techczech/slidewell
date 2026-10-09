// Contact sheet for the look-alike thresholds: 40 pairs of screenshots spread across cosine bands,
// side by side with cosine, dHash distance and a pair number. READ-ONLY on the inputs.
//
//   PAIRS_WELL=<well folder copy> PAIRS_OUT=<output folder> [PAIRS_SEED=14] npx vite-node scripts/look-alike-pairs.ts
//
// The well folder holds picture-search.db (triage vectors) and triage.db (paths, window titles, OCR).
// Output: <out>/pairs-01.png ... and <out>/pairs.json. Pairs whose window title, app or OCR text
// mention passwords, banking and the like are skipped. Nothing is written inside the repo.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { dHashOfFile } from '../src/main/look-alike/fingerprint'
import { hashDistance } from '../src/main/look-alike/groups'

const { PAIRS_WELL: wellDir, PAIRS_OUT: outDir, PAIRS_SEED: seedArg } = process.env
if (!wellDir || !outDir) throw new Error('set PAIRS_WELL (folder with picture-search.db and triage.db) and PAIRS_OUT')
mkdirSync(outDir, { recursive: true })

const BANDS: Array<{ lo: number; hi: number; want: number }> = [
  { lo: 0.8, hi: 0.85, want: 6 },
  { lo: 0.85, hi: 0.9, want: 7 },
  { lo: 0.9, hi: 0.93, want: 7 },
  { lo: 0.93, hi: 0.96, want: 7 },
  { lo: 0.96, hi: 0.98, want: 6 },
  { lo: 0.98, hi: 1.0001, want: 7 }
]
const bandName = (b: { lo: number; hi: number }): string => (b.hi > 1 ? `${b.lo.toFixed(2)}+` : `${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`)
const PRIVATE = /pass ?word|passcode|1password|bitwarden|lastpass|keychain|\bbank|banking|barclays|lloyds|natwest|hsbc|santander|monzo|starling|paypal|credit card|iban|sort code|account number|\bpin\b|secret|api[ _-]?key|token|\bssn\b|payslip|invoice|tax return|medical|nhs/i

let s = Number(seedArg ?? 14) >>> 0
const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 2 ** 32)

type Row = { hash: string; path: string; app: string; title: string; ocr: string }
const tdb = new DatabaseSync(join(wellDir, 'triage.db'), { readOnly: true })
const facts = new Map<string, Row>()
for (const r of tdb.prepare("SELECT hash, source, rel_path, app, window_title, ocr_text FROM triage_fts WHERE kind = 'image' AND offline = '0'").all() as Array<Record<string, string | null>>) {
  if (!r.source || !r.rel_path || facts.has(r.hash!)) continue
  facts.set(r.hash!, { hash: r.hash!, path: join(r.source, r.rel_path), app: r.app ?? '', title: r.window_title ?? '', ocr: r.ocr_text ?? '' })
}
const pdb = new DatabaseSync(join(wellDir, 'picture-search.db'), { readOnly: true })
const ids: string[] = []
const vecs: Float32Array[] = []
for (const r of pdb.prepare("SELECT id, vector FROM vectors WHERE kind = 'triage'").all() as Array<{ id: string; vector: Uint8Array }>) {
  const h = r.id.slice('triage:'.length)
  const f = facts.get(h)
  if (!f || PRIVATE.test(`${f.app} ${f.title} ${f.ocr} ${f.path}`)) continue
  try {
    const st = statSync(f.path)
    if (!st.isFile() || st.blocks === 0) continue // missing, or an online-only placeholder: never fetch
  } catch {
    continue
  }
  ids.push(h)
  const dv = new DataView(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength)
  const v = new Float32Array(r.vector.byteLength / 4)
  for (let i = 0; i < v.length; i++) v[i] = dv.getFloat32(i * 4, true)
  vecs.push(v)
}
console.log(`${ids.length} usable screenshots with a vector and a local file`)

// every pair once; reservoir-sample per band, and count the band sizes
type Pair = { a: number; b: number; cos: number }
const reservoirs = BANDS.map(() => [] as Pair[])
const seen = BANDS.map(() => 0)
const KEEP = 60
const dim = vecs[0].length
for (let i = 0; i < vecs.length; i++) {
  const a = vecs[i]
  for (let j = i + 1; j < vecs.length; j++) {
    const b = vecs[j]
    let c = 0
    for (let k = 0; k < dim; k++) c += a[k] * b[k]
    if (c < 0.8) continue
    const bi = BANDS.findIndex((x) => c >= x.lo && c < x.hi)
    if (bi < 0) continue
    seen[bi]++
    if (reservoirs[bi].length < KEEP) reservoirs[bi].push({ a: i, b: j, cos: c })
    else {
      const r = Math.floor(rnd() * seen[bi])
      if (r < KEEP) reservoirs[bi][r] = { a: i, b: j, cos: c }
    }
  }
}
console.log('pairs per band:', BANDS.map((b, i) => `${bandName(b)}=${seen[i]}`).join('  '))

const chosen: Array<Pair & { band: string; ha: bigint | null; hb: bigint | null }> = []
for (let bi = 0; bi < BANDS.length; bi++) {
  const used = new Set<number>()
  for (const p of reservoirs[bi]) {
    if (chosen.filter((c) => c.band === bandName(BANDS[bi])).length >= BANDS[bi].want) break
    if (used.has(p.a) || used.has(p.b)) continue // spread over different screenshots
    used.add(p.a)
    used.add(p.b)
    chosen.push({ ...p, band: bandName(BANDS[bi]), ha: await dHashOfFile(facts.get(ids[p.a])!.path), hb: await dHashOfFile(facts.get(ids[p.b])!.path) })
  }
}
// bands too thin to fill get topped up elsewhere only if the data has no more pairs: report the shortfall
console.log(`${chosen.length} pairs chosen`)

const W = 1440
const PER_PAGE = 10
const CELL_W = 640
const CELL_H = 300
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const pairsJson: unknown[] = []
const pages: number[] = []
for (let p0 = 0; p0 < chosen.length; p0 += PER_PAGE) {
  const slice = chosen.slice(p0, p0 + PER_PAGE)
  const ROW_H = CELL_H + 44
  const H = slice.length * ROW_H + 20
  const layers: sharp.OverlayOptions[] = []
  for (let k = 0; k < slice.length; k++) {
    const p = slice[k]
    const n = p0 + k + 1
    const top = 10 + k * ROW_H
    const d = p.ha !== null && p.hb !== null ? hashDistance(p.ha, p.hb) : null
    const label = `<svg width="${W}" height="40"><text x="20" y="28" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#111"><tspan font-weight="700">#${n}</tspan>   cosine ${p.cos.toFixed(3)}   dHash distance ${d === null ? 'n/a' : d}/64   band ${esc(p.band)}</text></svg>`
    layers.push({ input: Buffer.from(label), left: 0, top })
    for (const [side, idx] of [[0, p.a], [1, p.b]] as const) {
      const img = await sharp(facts.get(ids[idx])!.path, { failOn: 'none' }).resize(CELL_W, CELL_H, { fit: 'contain', background: '#f2efe8' }).png().toBuffer()
      layers.push({ input: img, left: 40 + side * (CELL_W + 80), top: top + 42 })
    }
    pairsJson.push({ pair: n, band: p.band, cosine: Number(p.cos.toFixed(4)), dhashDistance: d, a: `triage:${ids[p.a]}`, b: `triage:${ids[p.b]}`, page: Math.floor(p0 / PER_PAGE) + 1 })
  }
  const page = Math.floor(p0 / PER_PAGE) + 1
  pages.push(page)
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(layers).png().toFile(join(outDir, `pairs-${String(page).padStart(2, '0')}.png`))
}
writeFileSync(join(outDir, 'pairs.json'), JSON.stringify({ pairsPerBand: Object.fromEntries(BANDS.map((b, i) => [bandName(b), seen[i]])), pairs: pairsJson }, null, 2))
console.log(`wrote ${pages.length} pages and pairs.json to ${outDir}`)
