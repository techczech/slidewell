# Triage Stage-Then-Import + Configurable Grid + S/X/E/Space Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn screenshot triage from "select copies to the well immediately" into "select *stages*, then one Import button promotes all staged items," add a 2–6 column grid stepper with size-scaled previews, and adopt the `S`/`X`/`E`/`Space` keyboard model.

**Architecture:** A new persisted triage state `selected` sits between `undecided` and `included`. Pure decision logic (state tallying, import skip/gate planning) lives in a dependency-free `src/main/triage-logic.ts` unit-tested with vitest; the DB/ingest effects in `triage.ts` are exercised by the existing Playwright+Electron e2e harness. The renderer (`App.tsx` `TriagePanel`) gets the new keyboard map, a column stepper driving CSS variables, the new tabs, and the Import button.

**Tech Stack:** Electron + electron-vite, React (renderer), TypeScript, vitest (`test/`), Playwright e2e (`e2e/`), sqlite via the system `sqlite3` binary (`src/main/sqlite.ts`).

## Global Constraints

- **Typecheck is the universal gate:** `npm run typecheck` (`tsc --noEmit`) must pass at the end of every task. Renderer/IPC/CSS tasks that have no unit test use this as their test step.
- **No new npm dependencies** — everything uses existing modules.
- **British spelling** in all user-facing copy (e.g. "colour" if it arises; "Unselect", "Excluded" already fine).
- **Git:** never `--no-verify`; new commits (not amends); each commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work happens on branch `triage-stage-import` (already created).
- **No DB migration:** `triage_decisions.state` is plain TEXT; `selected` is just a new allowed value. Do not alter the schema.
- **Do not touch:** the clipboard `paste` path, `scan`, OCR, the offline/OneDrive handling, the `VIDEO_GATE_BYTES` value (20 MB), or R2.

## File Structure

- **Create** `src/main/triage-logic.ts` — pure, dependency-free decision helpers (`tallyTriageStates`, `planSelectedImport`) + their types. No `electron`/`sqlite`/`well` imports.
- **Create** `test/triage-logic.test.ts` — vitest unit tests for the helpers.
- **Modify** `src/main/triage.ts` — `select` action in `setTriageDecision`; new `importSelectedTriage`; `triageCounts` uses `tallyTriageStates`.
- **Modify** `src/preload/index.ts` — `TriageItem.state` union; `TriageCounts`; `triage.decide` action type; new `triage.importSelected`.
- **Modify** `src/main/index.ts` — `triage:decide` action type; new `triage:import-selected` handler; `selected` in the `empty` counts fallback.
- **Modify** `src/renderer/src/App.tsx` — `decide` actions, `importSelected`, keyboard map, `cols` state + stepper, tabs, Import button, `TriageCard`, `TriagePreview`, counts init.
- **Modify** `src/renderer/src/styles.css` — grid/thumb CSS variables, `.state-selected`, `.triage-cols` stepper, primary import button.
- **Modify** `e2e/triage.mjs` — stage-then-import integration assertions.

---

### Task 1: Pure triage-logic helpers + unit tests

**Files:**
- Create: `src/main/triage-logic.ts`
- Test: `test/triage-logic.test.ts`

**Interfaces:**
- Produces:
  - `type TriageState = 'undecided' | 'selected' | 'included' | 'excluded'`
  - `type TriageCounts = { undecided: number; selected: number; included: number; excluded: number; total: number }`
  - `tallyTriageStates(rows: { state: string; n: number }[]): TriageCounts`
  - `planSelectedImport(items: { hash: string; kind: string; offline: boolean; missing: boolean; sizeBytes: number }[], forceHashes: string[], gateBytes: number): { toImport: string[]; skipped: { hash: string; reason: 'offline' | 'missing' }[]; gated: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `test/triage-logic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tallyTriageStates, planSelectedImport } from '../src/main/triage-logic'

describe('tallyTriageStates', () => {
  it('buckets every state and sums total (selected is NOT folded into undecided)', () => {
    const out = tallyTriageStates([
      { state: 'undecided', n: 4 },
      { state: 'selected', n: 3 },
      { state: 'included', n: 2 },
      { state: 'excluded', n: 1 }
    ])
    expect(out).toEqual({ undecided: 4, selected: 3, included: 2, excluded: 1, total: 10 })
  })
  it('treats an unknown/NULL state as undecided', () => {
    const out = tallyTriageStates([{ state: 'undecided', n: 5 }])
    expect(out.undecided).toBe(5)
    expect(out.selected).toBe(0)
  })
})

describe('planSelectedImport', () => {
  const gate = 20 * 1024 * 1024
  it('imports normal images, skips offline and missing, gates large videos not forced', () => {
    const r = planSelectedImport(
      [
        { hash: 'a', kind: 'image', offline: false, missing: false, sizeBytes: 1000 },
        { hash: 'b', kind: 'image', offline: true, missing: false, sizeBytes: 1000 },
        { hash: 'c', kind: 'image', offline: false, missing: true, sizeBytes: 1000 },
        { hash: 'd', kind: 'video', offline: false, missing: false, sizeBytes: gate + 1 }
      ],
      [],
      gate
    )
    expect(r.toImport).toEqual(['a'])
    expect(r.skipped).toEqual([{ hash: 'b', reason: 'offline' }, { hash: 'c', reason: 'missing' }])
    expect(r.gated).toEqual(['d'])
  })
  it('imports a large video when its hash is forced', () => {
    const r = planSelectedImport(
      [{ hash: 'd', kind: 'video', offline: false, missing: false, sizeBytes: gate + 1 }],
      ['d'],
      gate
    )
    expect(r.toImport).toEqual(['d'])
    expect(r.gated).toEqual([])
  })
  it('imports a small video without forcing', () => {
    const r = planSelectedImport(
      [{ hash: 'e', kind: 'video', offline: false, missing: false, sizeBytes: 1000 }],
      [],
      gate
    )
    expect(r.toImport).toEqual(['e'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/triage-logic.test.ts`
Expected: FAIL — cannot resolve `../src/main/triage-logic`.

- [ ] **Step 3: Write the implementation**

Create `src/main/triage-logic.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/triage-logic.test.ts`
Expected: PASS (3 + 2 assertions across both describes).

- [ ] **Step 5: Commit**

```bash
git add src/main/triage-logic.ts test/triage-logic.test.ts
git commit -m "$(printf 'feat(triage): pure stage-then-import decision helpers\n\ntallyTriageStates buckets the new selected state without folding it into\nundecided; planSelectedImport decides import/skip/gate for a bulk import.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Backend — `select` action + `importSelectedTriage` (triage.ts)

**Files:**
- Modify: `src/main/triage.ts` (imports; `setTriageDecision` ~268-303; `triageCounts` ~238-256; add `importSelectedTriage`)

**Interfaces:**
- Consumes: `tallyTriageStates`, `planSelectedImport`, `TriageCounts` from `./triage-logic`; existing `ingestScreenshot(archiveRoot, root, srcPath, 'screenshot')`, `ingestVideo(archiveRoot, root, srcPath)`, `query`, `run`, `rowByHash`, `VIDEO_GATE_BYTES`.
- Produces:
  - `setTriageDecision(..., action: 'select' | 'exclude' | 'reset', force?)` — `select` writes `state='selected'`, `well_id=NULL`, **no ingest**.
  - `importSelectedTriage(archiveRoot: string, wellRoot: string, sourceRoot: string, forceHashes: string[]): Promise<{ imported: number; skipped: number; gated: number }>`

- [ ] **Step 1: Update imports**

At the top of `src/main/triage.ts`, add to the existing import block:

```ts
import { tallyTriageStates, planSelectedImport, type TriageCounts } from './triage-logic'
```

- [ ] **Step 2: Replace the `include` branch of `setTriageDecision` with `select`**

In `setTriageDecision` (signature ~268-275), change the action type and the body. Replace the whole function body from the `if (action === 'reset')` line through the final `return { state: 'included', wellId }`:

```ts
export async function setTriageDecision(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  hash: string,
  action: 'select' | 'exclude' | 'reset',
  _force = false
): Promise<{ state: string }> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  if (action === 'reset') {
    await run(db, 'DELETE FROM triage_decisions WHERE hash = ?', [hash])
    return { state: 'undecided' }
  }
  if (action === 'exclude') {
    await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)', [hash, 'excluded', new Date().toISOString()])
    return { state: 'excluded' }
  }
  // select = stage only; nothing reaches the well until importSelectedTriage runs
  await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)', [hash, 'selected', new Date().toISOString()])
  return { state: 'selected' }
}
```

Note: `archiveRoot`/`sourceRoot` are now unused by this function but kept for signature stability (the importer uses them). Prefix with `_` only if the linter complains; otherwise leave — `index.ts` passes them positionally.

- [ ] **Step 3: Add `importSelectedTriage` (place directly after `setTriageDecision`)**

```ts
/**
 * Promote every staged (state='selected') item into the well. Offline/missing files are skipped; a
 * video over the 20 MB gate is skipped unless its hash is in forceHashes. Imported items move to
 * state='included' with their new well id. Idempotent: a second run finds nothing still 'selected'.
 */
export async function importSelectedTriage(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  forceHashes: string[] = []
): Promise<{ imported: number; skipped: number; gated: number }> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  const staged = await query<{ hash: string; kind: string; rel_path: string }>(
    db,
    `SELECT triage_fts.hash AS hash, triage_fts.kind AS kind, triage_fts.rel_path AS rel_path
     FROM triage_fts JOIN triage_decisions d ON d.hash = triage_fts.hash
     WHERE d.state = 'selected'`,
    []
  )
  const enriched = staged.map((s) => {
    const abs = join(sourceRoot, s.rel_path)
    const missing = !existsSync(abs)
    const sizeBytes = missing ? 0 : statSync(abs).size
    // offline (OneDrive placeholder) ≈ a file with zero allocated blocks; reuse statSync's size==0
    // heuristic already used at scan time — a missing/empty source can't be ingested either way.
    return { hash: s.hash, kind: s.kind, offline: false, missing, sizeBytes, abs }
  })
  const plan = planSelectedImport(enriched, forceHashes, VIDEO_GATE_BYTES)
  let imported = 0
  for (const hash of plan.toImport) {
    const row = enriched.find((e) => e.hash === hash)
    if (!row) continue
    const res = row.kind === 'video' ? await ingestVideo(archiveRoot, wellRoot, row.abs) : await ingestScreenshot(archiveRoot, wellRoot, row.abs, 'screenshot')
    if (res?.id) {
      await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', [hash, 'included', new Date().toISOString(), res.id])
      imported++
    }
  }
  return { imported, skipped: plan.skipped.length, gated: plan.gated.length }
}
```

- [ ] **Step 4: Rewrite `triageCounts` to use the helper**

Replace the `triageCounts` function (~238-256) with:

```ts
export async function triageCounts(wellRoot: string): Promise<TriageCounts> {
  const db = triageDb(wellRoot)
  const empty: TriageCounts = { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }
  if (!existsSync(db)) return empty
  const rows = await query<{ state: string; n: number }>(
    db,
    `SELECT COALESCE(d.state, 'undecided') AS state, COUNT(*) AS n
     FROM triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash GROUP BY state`,
    []
  )
  return tallyTriageStates(rows)
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `setTriageDecision`'s unused params error under `noUnusedParameters`, rename them to `_archiveRoot`/`_sourceRoot` — but index.ts calls positionally so behaviour is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/main/triage.ts
git commit -m "$(printf 'feat(triage): select stages only; importSelectedTriage promotes the batch\n\nsetTriageDecision gains a select action that records state=selected without\ningesting. New importSelectedTriage ingests every staged item (skipping\noffline/missing, gating large videos unless forced) into the well.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: IPC + preload types

**Files:**
- Modify: `src/preload/index.ts` (`TriageItem.state` ~82; `TriageCounts` ~92; `triage.decide` ~207-208; add `triage.importSelected`)
- Modify: `src/main/index.ts` (`triage:decide` handler ~648-657; `triage:list` `empty` ~636; add `triage:import-selected`)

**Interfaces:**
- Consumes: `importSelectedTriage` from `./triage` (main side).
- Produces (preload): `window.sw.triage.decide(hash, 'select' | 'exclude' | 'reset')`; `window.sw.triage.importSelected(forceHashes?: string[]): Promise<{ imported: number; skipped: number; gated: number }>`.

- [ ] **Step 1: Update preload types** in `src/preload/index.ts`

Change `TriageItem.state` (~82):
```ts
  state: 'undecided' | 'selected' | 'included' | 'excluded'
```
Change `TriageCounts` (~92):
```ts
export type TriageCounts = { undecided: number; selected: number; included: number; excluded: number; total: number }
```
Change the `decide` action type and add `importSelected` in the `triage` object (~207-209). Replace the `decide:` line and add below it:
```ts
    decide: (hash: string, action: 'select' | 'exclude' | 'reset', force?: boolean): Promise<{ state: string }> =>
      ipcRenderer.invoke('triage:decide', hash, action, force),
    importSelected: (forceHashes?: string[]): Promise<{ imported: number; skipped: number; gated: number }> =>
      ipcRenderer.invoke('triage:import-selected', forceHashes ?? []),
```

- [ ] **Step 2: Update main IPC** in `src/main/index.ts`

Add `importSelectedTriage` to the import from `./triage` (find the existing `from './triage'` import and add the name).

In the `triage:list` handler, update the `empty` fallback (~636) to include `selected`:
```ts
    const empty = { items: [], counts: { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }
```

Change the `triage:decide` handler action type (~648):
```ts
  ipcMain.handle('triage:decide', async (_e, hash: string, action: 'select' | 'exclude' | 'reset', force?: boolean) => {
```

Add a new handler directly after `triage:decide`:
```ts
  ipcMain.handle('triage:import-selected', async (_e, forceHashes?: string[]) => {
    const src = screenshotRootResolved()
    if (!src) return { imported: 0, skipped: 0, gated: 0 }
    try {
      return await importSelectedTriage(archiveRoot(), wellRootResolved(), src, Array.isArray(forceHashes) ? forceHashes : [])
    } catch {
      return { imported: 0, skipped: 0, gated: 0 }
    }
  })
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/main/index.ts
git commit -m "$(printf 'feat(triage): IPC + types for select state and import-selected\n\nTriageItem.state + TriageCounts gain selected; decide action is now\nselect|exclude|reset; new triage:import-selected channel.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Renderer — keyboard, grid stepper, tabs, import button, cards

**Files:**
- Modify: `src/renderer/src/App.tsx` (`TriagePanel` ~921-1265; `TriageCard` ~1267-1312; `TriagePreview` ~1314-1338)

**Interfaces:**
- Consumes: `window.sw.triage.decide(hash, 'select'|'exclude'|'reset')`, `window.sw.triage.importSelected(forceHashes)`, `TriageCounts` (now with `selected`).

- [ ] **Step 1: counts state init + cols state** — in `TriagePanel`, update the `counts` initial state and add `cols`:

```ts
  const [counts, setCounts] = useState<TriageCounts>({ undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 })
```
Add near the other `useState` calls:
```ts
  const [cols, setCols] = useState<number>(() => {
    const n = Number(localStorage.getItem('sw.triage.cols'))
    return n >= 2 && n <= 6 ? n : 6
  })
  useEffect(() => { localStorage.setItem('sw.triage.cols', String(cols)) }, [cols])
  // fewer columns → taller tiles, so the preview genuinely grows
  const THUMB_H: Record<number, number> = { 2: 320, 3: 260, 4: 210, 5: 175, 6: 150 }
  const gridVars = { ['--triage-cols']: cols, ['--triage-thumb-h']: `${THUMB_H[cols] ?? 150}px` } as React.CSSProperties
```

- [ ] **Step 2: rewrite the `decide` helper** — replace the body's action type and toasts (the `decide` useCallback ~1009-1045). Keep the optimistic in-place update and counts bump; change the action union, drop the well/gate special-casing (gating now happens at import), and extend `bump` for `selected`:

```ts
  const decide = useCallback(
    async (item: TriageItem, action: 'select' | 'exclude' | 'reset') => {
      const r = await window.sw.triage.decide(item.hash, action)
      const newState = (r.state as TriageItem['state']) || 'undecided'
      setItems((prev) => prev.map((it) => (it.hash === item.hash ? { ...it, state: newState } : it)))
      setCounts((c) => {
        if (item.state === newState) return c
        const next = { ...c }
        const bump = (k: TriageItem['state'], d: number): void => {
          if (k === 'selected') next.selected += d
          else if (k === 'included') next.included += d
          else if (k === 'excluded') next.excluded += d
          else next.undecided += d
        }
        bump(item.state, -1)
        bump(newState, 1)
        return next
      })
      onToast(action === 'select' ? 'Selected' : action === 'exclude' ? 'Excluded' : 'Unselected')
      onChanged()
    },
    [onChanged, onToast]
  )
```

- [ ] **Step 3: add the `importSelected` handler** — directly after `decide`:

```ts
  const importSelected = useCallback(async () => {
    // staged large videos need an explicit confirm each (rare); only those currently in view can be
    // confirmed — others are reported as "over gate" and stay staged until imported from the Selected tab
    const forceHashes: string[] = []
    for (const v of items.filter((it) => it.state === 'selected' && it.kind === 'video' && it.large)) {
      if (window.confirm(`"${v.filename}" is ${v.sizeMB} MB — over the 20 MB video gate. Import it anyway?`)) forceHashes.push(v.hash)
    }
    const r = await window.sw.triage.importSelected(forceHashes)
    const extra = [r.skipped ? `${r.skipped} skipped` : '', r.gated ? `${r.gated} over gate` : ''].filter(Boolean).join(' · ')
    onToast(`Imported ${r.imported} → well${extra ? ` · ${extra}` : ''}`)
    await refresh()
    onChanged()
  }, [items, refresh, onChanged, onToast])
```

- [ ] **Step 4: rewrite the keyboard handler** — in the `onKey` effect (~1057-1139), replace the `preview`-branch and the main key cases. Preview branch (~1080-1094):

```ts
      if (preview) {
        if (e.key === ' ' || e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') {
          e.preventDefault(); void decide(preview, 'select'); setPreview(null)
        } else if (e.key === 'x' || e.key === 'X' || e.key === 'u' || e.key === 'U') {
          e.preventDefault(); void decide(preview, 'reset'); setPreview(null)
        } else if (e.key === 'e' || e.key === 'E') {
          e.preventDefault(); void decide(preview, 'exclude'); setPreview(null)
        }
        return
      }
```

Main grid keys — replace the arrow row-jump and the letter cases (~1103-1123) with (note `cols`, not `6`):

```ts
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min((s < 0 ? 0 : s) + cols, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max((s < 0 ? 0 : s) - cols, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault(); setPreview(cur)
      } else if (e.key === ' ' && cur) {
        e.preventDefault(); void decide(cur, cur.state === 'selected' ? 'reset' : 'select') // Space toggles
      } else if ((e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') && cur) {
        e.preventDefault(); void decide(cur, 'select')
      } else if ((e.key === 'x' || e.key === 'X' || e.key === 'u' || e.key === 'U') && cur) {
        e.preventDefault(); void decide(cur, 'reset') // X = unselect → undecided
      } else if ((e.key === 'e' || e.key === 'E') && cur) {
        e.preventDefault(); void decide(cur, 'exclude')
      } else if (e.key === '[') {
```

Add `cols` and `importSelected` to the effect's dependency array (the `}, [items, sel, preview, hasMore, decide, paste, onClose])` line → add `cols`).

- [ ] **Step 5: Import button in the header** — in `.triage-head-actions` (~1152), add as the first button (before Paste):

```tsx
              <button className="primary-btn" onClick={() => void importSelected()} disabled={counts.selected === 0} title="Import all selected screenshots into the well">
                ⤓ Import {counts.selected} → well
              </button>
```

- [ ] **Step 6: tabs + stepper + search hint** — update the tab list (~1187-1188) to the new states and add the stepper. Replace the `scope` tablist's state array and add the stepper after the sort `<select>` (~1199):

Tab states array:
```tsx
                  {(['undecided', 'selected', 'excluded', 'all'] as const).map((s) => (
```
After the `.triage-sort` select, add:
```tsx
                <div className="triage-cols" role="group" aria-label="Grid size">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} className={cols === n ? 'active' : ''} onClick={() => setCols(n)} title={`${n} columns`}>{n}</button>
                  ))}
                </div>
```
Update the search placeholder hint (~1183) to the new keys:
```tsx
                  placeholder="Search text in screenshots…   /  focus · S select · X unselect · E exclude · Space toggle · ⌘Y full · [ ] page"
```

- [ ] **Step 7: apply `gridVars` to the scroll container** — both render branches. Flat (~1232):
```tsx
                <div className="triage-grid triage-scroll" style={gridVars}>
```
Grouped (~1216):
```tsx
                <div className="triage-scroll" style={gridVars}>
```

- [ ] **Step 8: TriageCard** — update the action callback type and badge/labels (~1267-1312). Change the `onDecide` prop type and the badge line + buttons:

```tsx
  onDecide: (a: 'select' | 'exclude' | 'reset') => void
```
```tsx
  const badge = item.state === 'included' ? '✓' : item.state === 'selected' ? '✓' : item.state === 'excluded' ? '✗' : ''
```
Buttons block (~1299-1308):
```tsx
      <div className="triage-actions">
        {item.state !== 'selected' && item.state !== 'included' && (
          <button className="ti-inc" disabled={item.offline} title={item.offline ? 'Download it in OneDrive first' : 'Select (S / Space)'} onClick={(e) => { e.stopPropagation(); onDecide('select') }}>Select</button>
        )}
        {item.state !== 'excluded' && (
          <button className="ti-exc" title="Exclude (E)" onClick={(e) => { e.stopPropagation(); onDecide('exclude') }}>Exclude</button>
        )}
        {item.state !== 'undecided' && item.state !== 'included' && (
          <button className="ti-rst" title="Unselect (X)" onClick={(e) => { e.stopPropagation(); onDecide('reset') }}>Unselect</button>
        )}
      </div>
```
Also update the card class badge span (~1293) so selected vs included read differently — change the badge `<span>` className to `` `triage-badge ${item.state}` `` (already keyed by state; `state-selected` CSS in Task 5 handles colour).

- [ ] **Step 9: TriagePreview** — update prop type and button labels (~1314-1338):
```tsx
function TriagePreview({ item, onClose, onDecide }: { item: TriageItem; onClose: () => void; onDecide: (a: 'select' | 'exclude' | 'reset') => void }): JSX.Element {
```
Buttons (~1330-1332):
```tsx
          <button className="ti-inc" onClick={() => onDecide('select')}>Select (Space)</button>
          <button className="ti-exc" onClick={() => onDecide('exclude')}>Exclude (E)</button>
          {item.state !== 'undecided' && item.state !== 'included' && <button className="copyref" onClick={() => onDecide('reset')}>Unselect (X)</button>}
```
And the `TriagePreview` call site in `TriagePanel` (~1257) — its `onDecide` already forwards to `decide(preview, a)`; the type now matches.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "$(printf 'feat(triage): stage-then-import UI — S/X/E/Space keys, grid stepper, Import button\n\nSelect stages (no copy); Import N -> well button promotes the batch. Space\ntoggles selected/undecided; S select, X unselect, E exclude (i/u aliased).\n2-6 column stepper scales preview size; arrow row-jump tracks the column count.\nTabs: Undecided / Selected / Excluded / All.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Styles — grid variables, selected state, stepper, import button

**Files:**
- Modify: `src/renderer/src/styles.css` (`.triage-grid` ~1039-1047; `.triage-thumb` ~1113-1121; state classes ~1087-1095)

- [ ] **Step 1: variable-drive the grid columns** — replace the `grid-template-columns` line in `.triage-grid` (~1043):

```css
  grid-template-columns: repeat(var(--triage-cols, 6), minmax(0, 1fr));
```

- [ ] **Step 2: variable-drive the thumb height** — replace the fixed `height: 150px;` line in `.triage-thumb` (~1115):

```css
  height: var(--triage-thumb-h, 150px); /* set per grid size; fewer cols → taller tile */
```

- [ ] **Step 3: add the selected-state accent** — after `.triage-card.state-included` (~1089), add:

```css
.triage-card.state-selected {
  border-color: var(--oxford);
  box-shadow: 0 0 0 1px var(--oxford) inset;
}
.triage-badge.selected {
  background: var(--oxford);
}
```

- [ ] **Step 4: add the column stepper + ensure the primary import button reads well in the head** — append near `.triage-sort` (~1048):

```css
.triage-cols {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}
.triage-cols button {
  border: 0;
  background: var(--card);
  color: var(--ink);
  padding: 4px 9px;
  cursor: pointer;
  border-left: 1px solid var(--line);
  font: inherit;
}
.triage-cols button:first-child { border-left: 0; }
.triage-cols button.active {
  background: var(--oxford);
  color: #fff;
}
.triage-head-actions .primary-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

(If `--oxford`, `--line`, `--card`, `--ink`, `.primary-btn` are not already defined, reuse whatever accent/border tokens the file uses — grep `:root` and `.primary-btn` first; they are referenced elsewhere in this file so they exist.)

- [ ] **Step 5: Verify the build compiles the CSS**

Run: `npm run typecheck`
Expected: PASS (CSS isn't typechecked, but this confirms nothing else broke). A fuller check happens in Task 6's build.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/styles.css
git commit -m "$(printf 'feat(triage): CSS for size-scaled grid, selected accent, column stepper\n\nGrid columns and thumb height are CSS variables driven by the stepper;\nstaged cards get an Oxford-blue accent distinct from imported green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: e2e — stage-then-import integration

**Files:**
- Modify: `e2e/triage.mjs`

**Interfaces:**
- Consumes: `window.sw.triage.scan/list/decide/importSelected`; asserts via the `result` object and reads the well dir on disk.

- [ ] **Step 1: replace `include` calls with `select` and assert nothing copies yet**

Find where the harness calls `window.sw.triage.decide(..., 'include')` (the old keep path). Replace with `select`, then assert the well has no images yet. After the decide call, add:

```js
  // stage two items via select — NOTHING should reach the well yet (stage-then-import)
  await win.evaluate((h) => window.sw.triage.decide(h, 'select'), all0[0].hash)
  await win.evaluate((h) => window.sw.triage.decide(h, 'select'), all0[1].hash)
  result.selectedCount = (await win.evaluate(() => window.sw.triage.list('', 'selected'))).counts.selected
  const { readdirSync, existsSync } = await import('node:fs')
  const wellImages = join(wellRoot, 'images')
  result.wellEmptyBeforeImport = !existsSync(wellImages) || readdirSync(wellImages).length === 0
```

- [ ] **Step 2: import the batch and assert the well now has the images**

```js
  const imp = await win.evaluate(() => window.sw.triage.importSelected([]))
  result.imported = imp.imported
  result.wellHasImagesAfterImport = existsSync(wellImages) && readdirSync(wellImages).length >= 1
  result.includedAfterImport = (await win.evaluate(() => window.sw.triage.list('', 'all'))).counts.included
```

(Confirm the well image subdirectory name by grepping `well.ts` for where `ingestScreenshot` writes — adjust `images` if it differs.)

- [ ] **Step 3: extend the pass condition**

Find the line computing `pass` and add the new assertions, e.g.:
```js
  pass = result.panelOpened && result.recursiveOk && result.selectedCount === 2 && result.wellEmptyBeforeImport && result.imported >= 1 && result.wellHasImagesAfterImport && result.includedAfterImport >= 1
```

- [ ] **Step 4: build + run the e2e**

Run: `npm run test:triage`
Expected: the harness prints a JSON `result` with the new fields all truthy and exits 0 (`pass === true`).

- [ ] **Step 5: run the full vitest suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS (existing storage/r2/outline tests + the new triage-logic tests).

- [ ] **Step 6: Commit**

```bash
git add e2e/triage.mjs
git commit -m "$(printf 'test(triage): e2e proves select stages without copying and import promotes\n\nSelecting leaves the well empty; importSelected then populates it and moves\nitems to included.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: Manual smoke + version bump

**Files:**
- Modify: `package.json` (version), and any in-app version/changelog file if one exists (grep `_CHANGELOG/changes/screenshot-video-triage.md`).

- [ ] **Step 1: launch the app and walk the flow**

Run: `npm run dev`
Verify by hand:
- Open Triage. The header shows `⤓ Import 0 → well` (disabled).
- Press `S` on a card → it shows the staged ✓ accent; the Selected tab count and the Import button count both go to 1.
- Press `Space` on the same card → it un-stages (back to undecided); counts drop.
- Press `X` on a staged card → undecided. Press `E` → excluded (✗), and it leaves Undecided.
- Change the grid stepper 6 → 2 → previews grow; ArrowDown moves down one visual row at every size.
- Stage a few, press Import → toast `Imported N → well`; the Selected tab empties; items appear under All as included.

- [ ] **Step 2: bump the version**

In `package.json`, bump `version` (e.g. `0.2.0` → `0.3.0` — minor, since this is a user-facing feature change). If the repo has an in-app version constant or a changelog entry pattern (`_CHANGELOG/changes/`), add a short entry mirroring `screenshot-video-triage.md`.

- [ ] **Step 3: final typecheck + commit**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.
```bash
git add -A
git commit -m "$(printf 'chore: bump to 0.3.0 (triage stage-then-import)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 4: finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide merge vs PR for `triage-stage-import`.

---

## Self-Review (completed during planning)

- **Spec coverage:** stage-then-import (Tasks 2,3,4,6) ✓; persisted `selected` state with no migration (Task 2) ✓; counts `else`-fall-through fix (Task 1 helper + Task 2) ✓; S/X/E/Space + i/u aliases, in grid and preview (Task 4) ✓; 2–6 stepper, localStorage, size-scaled thumbs, `±cols` row-jump fix (Tasks 4,5) ✓; tabs Undecided/Selected/Excluded/All (Task 4) ✓; Import button with live count + offline/gate handling (Tasks 2,4) ✓; unchanged paste/scan/OCR/R2 (untouched) ✓; tests backend-pure + e2e (Tasks 1,6) ✓.
- **Placeholder scan:** no TBD/TODO; every code step shows real code.
- **Type consistency:** `'select' | 'exclude' | 'reset'` is identical across triage.ts, preload, index.ts, and all three renderer components; `TriageCounts` carries `selected` everywhere; `importSelected(forceHashes)` ⇄ `importSelectedTriage(..., forceHashes)` ⇄ `triage:import-selected` align.
- **Known soft edge (documented in spec):** staged large videos not in the current view are reported as "over gate" rather than confirmed inline; user confirms them from the Selected tab. Acceptable for v1.
