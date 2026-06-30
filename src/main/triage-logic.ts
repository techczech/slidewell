/**
 * Pure triage decision logic (ADR-0029, stage-then-import revision). NO electron/sqlite/well imports
 * so it is unit-testable in vitest and importable from either process. The DB and ingest *effects*
 * live in triage.ts; this module only decides.
 */
export type TriageState = 'undecided' | 'selected' | 'included' | 'excluded'

export type TriageCounts = { undecided: number; selected: number; included: number; excluded: number; total: number }

/** Bucket a `GROUP BY state` result. An unknown/NULL state counts as undecided. */
export function tallyTriageStates(rows: { state: string; n: number }[]): TriageCounts {
  const out: TriageCounts = { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }
  for (const r of rows) {
    const n = Number(r.n)
    out.total += n
    if (r.state === 'selected') out.selected += n
    else if (r.state === 'included') out.included += n
    else if (r.state === 'excluded') out.excluded += n
    else out.undecided += n
  }
  return out
}

/**
 * Given the staged items, decide what a bulk import does. Offline (not downloaded) and missing files
 * cannot be ingested → skipped with a reason. A video over `gateBytes` whose hash is not in
 * `forceHashes` is gated (skipped). Everything else imports.
 */
export function planSelectedImport(
  items: { hash: string; kind: string; offline: boolean; missing: boolean; sizeBytes: number }[],
  forceHashes: string[],
  gateBytes: number
): { toImport: string[]; skipped: { hash: string; reason: 'offline' | 'missing' }[]; gated: string[] } {
  const force = new Set(forceHashes)
  const toImport: string[] = []
  const skipped: { hash: string; reason: 'offline' | 'missing' }[] = []
  const gated: string[] = []
  for (const it of items) {
    if (it.missing) skipped.push({ hash: it.hash, reason: 'missing' })
    else if (it.offline) skipped.push({ hash: it.hash, reason: 'offline' })
    else if (it.kind === 'video' && it.sizeBytes > gateBytes && !force.has(it.hash)) gated.push(it.hash)
    else toImport.push(it.hash)
  }
  return { toImport, skipped, gated }
}
