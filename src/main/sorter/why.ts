/**
 * Why, in plain words (ticket 22): for a screenshot in the teach queue or in Review, a reason taken
 * from his own history rather than from the sorter's wording. In order:
 *
 *   1. The app is known and he has decided at least WHY_MIN_DECIDED screenshots from it:
 *      "You kept K of the last M from <app>" (M = his most recent decisions from it, at most WHY_LAST).
 *   2. Otherwise, when the screenshot's picture and at least WHY_NEIGHBOURS of his choices have a
 *      stored embedding: the WHY_NEIGHBOURS nearest of his choices (cosine), as
 *      "Looks like N of 5 nearby screenshots you threw away" (or "you kept", whichever is more).
 *   3. Otherwise the sorter's own reason.
 *
 * Reads only, and only what is already stored: his decisions and the app names (triage.db), and
 * embeddings the picture index already holds (`storedVectors`; nothing is embedded here and nothing
 * new is stored). The neighbour search runs for at most WHY_NEIGHBOUR_CAP screenshots per call (the
 * rest fall back to the sorter's reason), so a long list cannot hold the main process up.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { triageImageId } from '../picture-search/vector-store'
import { appKey } from '../triage-logic'
import { loadLabelled } from './store'

export const WHY_MIN_DECIDED = 5
export const WHY_LAST = 20
export const WHY_NEIGHBOURS = 5
export const WHY_NEIGHBOUR_CAP = 100

/** His decisions per app (appKey), newest first: true = kept. */
export type AppHistory = Map<string, boolean[]>

/** One of his choices with a stored embedding. */
export type LabelledVector = { vector: Float32Array; keep: boolean }

export type WhyItem = { hash: string; app: string | null; reason: string }

/** Rule 1; null when the app is not known or he has decided too few from it. */
export function whyFromApp(app: string | null | undefined, history: AppHistory): string | null {
  const name = (app ?? '').trim()
  if (!name) return null
  const decided = history.get(appKey(name)) ?? []
  if (decided.length < WHY_MIN_DECIDED) return null
  const last = decided.slice(0, WHY_LAST)
  return `You kept ${last.filter(Boolean).length} of the last ${last.length} from ${name}`
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Rule 2; null when there are too few of his choices to compare with. Ties in the count read as kept. */
export function whyFromNeighbours(vector: Float32Array | undefined, labelled: readonly LabelledVector[]): string | null {
  if (!vector || labelled.length < WHY_NEIGHBOURS) return null
  // the nearest few, kept in order: nearest first
  const best: Array<{ score: number; keep: boolean }> = []
  for (const l of labelled) {
    if (l.vector.length !== vector.length) continue
    const score = dot(vector, l.vector)
    if (best.length === WHY_NEIGHBOURS && score <= best[best.length - 1].score) continue
    let at = best.length
    while (at > 0 && best[at - 1].score < score) at--
    best.splice(at, 0, { score, keep: l.keep })
    if (best.length > WHY_NEIGHBOURS) best.pop()
  }
  if (best.length < WHY_NEIGHBOURS) return null
  const kept = best.filter((b) => b.keep).length
  const thrown = best.length - kept
  return thrown > kept ? `Looks like ${thrown} of ${best.length} nearby screenshots you threw away` : `Looks like ${kept} of ${best.length} nearby screenshots you kept`
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))
}

/**
 * His keep and throw-away decisions per app, newest first, with a signature that changes when a
 * decision is made or undone. A decision counts once per picture, under the app name of its file.
 */
export function readAppHistory(wellRoot: string): { history: AppHistory; signature: string } {
  const history: AppHistory = new Map()
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return { history, signature: '0' }
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  try {
    if (!hasTable(db, 'triage_decisions') || !hasTable(db, 'triage_fts')) return { history, signature: '0' }
    const decided = db
      .prepare("SELECT hash, state, decided_at FROM triage_decisions WHERE state IN ('selected', 'included', 'excluded') ORDER BY decided_at DESC, hash")
      .all() as Array<{ hash: string; state: string; decided_at: string | null }>
    const appOf = new Map<string, string>()
    // triage_fts cannot be joined on hash (review/store.ts): read once
    for (const f of db.prepare('SELECT hash, app FROM triage_fts').all() as Array<{ hash: string; app: string | null }>) {
      if (f.app && f.app.trim() && !appOf.has(f.hash)) appOf.set(f.hash, f.app)
    }
    for (const d of decided) {
      const app = appOf.get(d.hash)
      if (!app) continue
      const key = appKey(app)
      const list = history.get(key)
      const keep = d.state !== 'excluded'
      if (list) list.push(keep)
      else history.set(key, [keep])
    }
    return { history, signature: `${decided.length}:${decided[0]?.decided_at ?? ''}:${decided[0]?.hash ?? ''}` }
  } finally {
    db.close()
  }
}

export type WhyDeps = {
  wellRoot: () => string
  /** Embeddings already in the picture index for these ids; absent ones are simply not in the map. Must not embed anything. */
  storedVectors: (ids: string[]) => Map<string, Float32Array>
}

/**
 * The reader Review and the teach queue use: `why` for each item, by hash. His choices' embeddings
 * are read once and kept until a decision is made or undone (or the well changes). Never throws: an
 * item it cannot explain gets the sorter's reason.
 */
export function whyReader(deps: WhyDeps): (items: readonly WhyItem[]) => Map<string, string> {
  let cache: { root: string; signature: string; labelled: LabelledVector[] } | null = null
  const labelledFor = (root: string, signature: string): LabelledVector[] => {
    if (cache && cache.root === root && cache.signature === signature) return cache.labelled
    const shots = loadLabelled(root).filter((s) => s.image && s.truth)
    const vectors = deps.storedVectors(shots.map((s) => s.image!.id))
    const labelled = shots.flatMap((s): LabelledVector[] => {
      const v = vectors.get(s.image!.id)
      return v ? [{ vector: v, keep: s.truth === 'keep' }] : []
    })
    cache = { root, signature, labelled }
    return labelled
  }
  return (items) => {
    const out = new Map<string, string>()
    try {
      const root = deps.wellRoot()
      const { history, signature } = readAppHistory(root)
      const rest: WhyItem[] = []
      for (const it of items) {
        const fromApp = whyFromApp(it.app, history)
        if (fromApp) out.set(it.hash, fromApp)
        else rest.push(it)
      }
      const near = rest.slice(0, WHY_NEIGHBOUR_CAP)
      if (near.length) {
        const labelled = labelledFor(root, signature)
        const own = labelled.length >= WHY_NEIGHBOURS ? deps.storedVectors(near.map((it) => triageImageId(it.hash))) : new Map<string, Float32Array>()
        for (const it of near) {
          const w = whyFromNeighbours(own.get(triageImageId(it.hash)), labelled)
          if (w) out.set(it.hash, w)
        }
      }
    } catch {
      /* the sorter's reason stands for whatever is not in the map */
    }
    for (const it of items) if (!out.has(it.hash)) out.set(it.hash, it.reason)
    return out
  }
}
