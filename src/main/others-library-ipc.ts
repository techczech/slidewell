import type { Dialog } from 'electron'
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { archiveResults, listDecks, searchImages, type SearchFilters } from './archive'
import { invalidateDeckMeta } from './deckmeta'
import { runIngest } from './ingest'
import { foldersOverlap } from './settings-rules'
import type { AppHandle } from './app-handle'

interface Dependencies {
  appHandle: AppHandle
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>
  archiveRoot: () => string
  archiveAvailable: () => boolean
  othersArchiveRootResolved: () => string
  othersArchiveAvailable: () => boolean
  readConfig: () => { othersArchiveRoot?: string }
  writeConfig: (patch: { othersArchiveRoot: string }) => unknown
  cacheDir: () => string
  python: () => string
  sendConvertLine: (line: string) => void
}

export function install(deps: Dependencies): void {
  const { appHandle, dialog, archiveRoot, archiveAvailable, othersArchiveRootResolved, othersArchiveAvailable, readConfig, writeConfig, cacheDir, python, sendConvertLine } = deps
  // --- Others' Library (Scenario A, ADR-0031): a separate store for other people's decks ---
  appHandle('settings:choose-others-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const picked = r.filePaths[0]
    // Never let the Others' Library overlap the personal archive — that would defeat the separation.
    if (foldersOverlap(picked, archiveRoot())) {
      await dialog.showMessageBox({ type: 'warning', buttons: ['OK'], message: "That folder overlaps your own archive.", detail: 'Pick a separate location for the Others’ Library so other people’s slides never mix into your archive.' })
      return readConfig().othersArchiveRoot ?? null
    }
    writeConfig({ othersArchiveRoot: picked })
    return picked
  })
  // Purge the whole Others' Library (its built store only) — never touches the personal archive.
  appHandle('settings:clear-others-library', async () => {
    const root = othersArchiveRootResolved()
    if (foldersOverlap(root, archiveRoot())) return { ok: false }
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Clear it'],
      defaultId: 0,
      cancelId: 0,
      message: 'Clear the Others’ Library?',
      detail: `Deletes everything imported into ${root}. Your own archive is untouched.`
    })
    if (res.response !== 1) return { ok: false, cancelled: true }
    for (const sub of ['extracted', 'registry', 'media-store']) {
      try { rmSync(join(root, sub), { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    return { ok: true }
  })

  // Delete-by-filter (ADR-0031): remove every Others' Library deck matching the current query +
  // filters, then rebuild the index from what remains. No filter → deletes the whole library.
  // Scoped to the Others' Library only — never the personal archive.
  appHandle('others:delete-matching', async (_e, query: string, filters: SearchFilters) => {
    const root = othersArchiveRootResolved()
    if (!othersArchiveAvailable()) return { ok: false, deleted: 0 }
    const f: SearchFilters = { ...filters, owner: 'all', library: 'others' }
    // Decks matching the deck-level filters; narrowed to those with matching content when there's free text.
    const ids = new Set<string>()
    try {
      for (const d of await listDecks(root, cacheDir(), f)) ids.add(d.id)
    } catch {
      /* none */
    }
    const q = (query ?? '').trim()
    if (q.length >= 2 && ids.size) {
      const hit = new Set<string>()
      try {
        for (const c of await archiveResults(root, cacheDir(), q, f)) {
          if (c.representative.deck) hit.add(c.representative.deck)
          for (const m of c.members) if (m.deck) hit.add(m.deck)
        }
      } catch {
        /* none */
      }
      try {
        for (const im of await searchImages(root, q, 1000)) if (im.deck) hit.add(im.deck)
      } catch {
        /* none */
      }
      for (const id of [...ids]) if (!hit.has(id)) ids.delete(id)
    }
    const idList = [...ids].filter(Boolean)
    if (idList.length === 0) return { ok: false, deleted: 0 }
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', `Delete ${idList.length}`],
      defaultId: 0,
      cancelId: 0,
      message: `Delete ${idList.length} presentation${idList.length === 1 ? '' : 's'} from your Others' Library?`,
      detail: 'Removed from this separate store only — your own archive and the source files are untouched.'
    })
    if (res.response !== 1) return { ok: false, cancelled: true }
    for (const id of idList) {
      try {
        rmSync(join(root, 'extracted', id), { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
    // Rebuild the index from what's left (registry/media-store are derived, so wipe + reindex).
    try {
      rmSync(join(root, 'registry'), { recursive: true, force: true })
    } catch {
      /* */
    }
    try {
      rmSync(join(root, 'media-store'), { recursive: true, force: true })
    } catch {
      /* */
    }
    let remaining = 0
    try {
      remaining = readdirSync(join(root, 'extracted')).length
    } catch {
      remaining = 0
    }
    if (remaining > 0 && archiveAvailable()) {
      await runIngest({ engineRoot: archiveRoot(), dataRoot: root, python: python(), mode: 'reindex' }, sendConvertLine)
    }
    invalidateDeckMeta(cacheDir()) // the deck set changed; drop the cached index so search reflects it
    return { ok: true, deleted: idList.length }
  })
}
