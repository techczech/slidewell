import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { writeRescored } = await import('../src/main/sorter/rescore')
const { makeCloudWell, lunaStub, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')

/**
 * A retrain re-scores a doubtful screenshot while a cloud request about it is out. The answer must be
 * applied to the row as it is when the answer is saved, never to what the batch read before the request.
 */
let wells: string[] = []
afterEach(() => {
  for (const w of wells) rmSync(w, { recursive: true, force: true })
  wells = []
})

type Row = { proposal: string; confidence: number; p_keep: number; reason: string; model_id: string | null; sorter_version: string; decided_by: string | null; proposed_at: string }
const sql = <T>(w: string, fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const row = (w: string, name: string): Row => sql(w, (db) => db.prepare('SELECT proposal, confidence, p_keep, reason, model_id, sorter_version, decided_by, proposed_at FROM sorter_proposals WHERE hash = ?').get(hashOf(name)) as never)
const answers = (w: string, name: string): Array<{ provider: string; verdict: string }> => sql(w, (db) => db.prepare('SELECT provider, verdict FROM sorter_cloud_answers WHERE hash = ?').all(hashOf(name)) as never)

/** One doubtful screenshot the batch reads at p(keep) 0.51; `window` decides what the stub answers. */
function well(window: string): string {
  const w = makeCloudWell([{ hash: 'shot', proposal: 'doubtful', window, takenAt: '2026-10-04T10:00:00' }])
  wells.push(w)
  sql(w, (db) => db.prepare('UPDATE sorter_proposals SET p_keep = 0.51, confidence = 0.51').run())
  return w
}

/** What a retrain's re-score writes while the request is out: p(keep) 0.69 under a new model. */
function rescore(w: string, proposal: 'doubtful' | 'keep' = 'doubtful'): void {
  const written = writeRescored(w, [{ hash: hashOf('shot'), proposal, confidence: 0.69, pKeep: 0.69, reason: 'Not sure: it looks a little like screenshots you kept', rule: null, decidedBy: null, proposedAt: row(w, 'shot').proposed_at }], SORTER_VERSION, 'model-after-retrain')
  expect(written).toEqual([hashOf('shot')])
}

/** Run the cloud step; `during` runs while the request is out, after the batch has read its rows. */
async function run(w: string, during: () => void): Promise<Awaited<ReturnType<InstanceType<typeof CloudSorter>['runNightly']>>> {
  const stub = lunaStub()
  const s = await new CloudSorter(
    cloudDeps(w, {
      http: async (url, init) => {
        during()
        return stub.http(url, init)
      }
    })
  ).runNightly()
  expect(stub.seen).toHaveLength(1)
  return s
}

describe('a cloud answer that arrives after a re-score', () => {
  it('an unsure answer keeps the re-scored probability under the new model', async () => {
    const w = well('blurry')
    const s = await run(w, () => rescore(w))
    expect(row(w, 'shot')).toMatchObject({ proposal: 'doubtful', p_keep: 0.69, confidence: 0.69, model_id: 'model-after-retrain', decided_by: 'luna' })
    expect(row(w, 'shot').reason).toMatch(/Luna was not sure either/)
    expect(s).toMatchObject({ asked: 1, answered: 1, keep: 0, throwaway: 0, stayedDoubtful: 1 })
  })

  it('a throwaway answer that is not sure enough also keeps the re-scored probability', async () => {
    const w = well('weak-picker')
    await run(w, () => rescore(w))
    expect(row(w, 'shot')).toMatchObject({ proposal: 'doubtful', p_keep: 0.69, confidence: 0.69, model_id: 'model-after-retrain' })
  })

  it('a keep answer is applied on top of the re-scored row', async () => {
    const w = well('keep-chart')
    const s = await run(w, () => rescore(w))
    expect(row(w, 'shot')).toMatchObject({ proposal: 'keep', p_keep: 0.93, confidence: 0.93, model_id: 'model-after-retrain', decided_by: 'luna', reason: 'A chart worth keeping' })
    expect(s).toMatchObject({ answered: 1, keep: 1 })
  })

  it('a throwaway answer is applied on top of the re-scored row', async () => {
    const w = well('toss-wifi')
    await run(w, () => rescore(w))
    const r = row(w, 'shot')
    expect(r).toMatchObject({ proposal: 'throwaway', confidence: 0.97, model_id: 'model-after-retrain', decided_by: 'luna' })
    expect(r.p_keep).toBeCloseTo(0.03)
  })

  it('a row the re-score moved to sure is left alone; the answer is still recorded', async () => {
    const w = well('toss-wifi')
    const s = await run(w, () => rescore(w, 'keep'))
    expect(row(w, 'shot')).toMatchObject({ proposal: 'keep', p_keep: 0.69, model_id: 'model-after-retrain', decided_by: null })
    expect(answers(w, 'shot')).toEqual([{ provider: 'openai', verdict: 'throwaway' }])
    expect(s).toMatchObject({ answered: 0, keep: 0, throwaway: 0 })
  })

  it('a row that is no longer at the current sorter version is left alone; the answer is still recorded', async () => {
    const w = well('keep-chart')
    await run(w, () => sql(w, (db) => db.prepare("UPDATE sorter_proposals SET sorter_version = 'sorter-older'").run()))
    expect(row(w, 'shot')).toMatchObject({ proposal: 'doubtful', p_keep: 0.51, sorter_version: 'sorter-older', decided_by: null })
    expect(answers(w, 'shot')).toEqual([{ provider: 'openai', verdict: 'keep' }])
  })

  it('with nothing changed meanwhile the answer is applied as before', async () => {
    const w = well('blurry')
    await run(w, () => undefined)
    expect(row(w, 'shot')).toMatchObject({ proposal: 'doubtful', p_keep: 0.51, confidence: 0.51, model_id: 'model-test', decided_by: 'luna' })
  })
})

describe('saveCloudResults from the live row', () => {
  it('reads each row inside the transaction and skips one that is not open', () => {
    const w = makeCloudWell([
      { hash: 'open', proposal: 'doubtful' },
      { hash: 'sure', proposal: 'keep' },
      { hash: 'his', proposal: 'doubtful', decided: 'included' },
      { hash: 'answered', proposal: 'doubtful', answered: true }
    ])
    wells.push(w)
    const st = new SorterStore(w)
    try {
      const seen: string[] = []
      const names = ['open', 'sure', 'his', 'answered', 'no-such-shot']
      const changed = st.saveCloudResults(
        names.map((n) => ({ hash: hashOf(n), verdict: 'keep' as const, confidence: 0.9, reason: 'x', provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-13T09:00:00.000Z' })),
        {
          sorterVersion: SORTER_VERSION,
          hashes: names.map(hashOf),
          combine: (hash, live) => {
            seen.push(hash)
            return { proposal: 'keep', confidence: 0.9, pKeep: live.pKeep + 0.5, reason: `was ${live.reason}`, decidedBy: 'luna', decidedModel: 'gpt-6-luna' }
          }
        }
      )
      expect(seen).toEqual([hashOf('open')])
      expect(changed).toEqual([hashOf('open')])
    } finally {
      st.close()
    }
    expect(row(w, 'open')).toMatchObject({ proposal: 'keep', p_keep: 0.9, reason: 'was local reason for open' })
    expect(sql(w, (db) => Number((db.prepare('SELECT COUNT(*) AS n FROM sorter_cloud_answers').get() as { n: number }).n))).toBe(5)
  })
})
