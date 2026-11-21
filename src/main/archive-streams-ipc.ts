import { dialog, shell } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { convertPptxToOutline } from './convert'
import { invalidateDeckMeta, setOwnerNames } from './deckmeta'
import { cancelIngest, runIngest } from './ingest'
import { slugify } from './outline'
import { cleanOwnerNames, resolveOwnerNames } from './owners'
import type { PictureSearchService } from './picture-search/service'
import { foldersOverlap, OVERLAP_REASON } from './settings-rules'
import type { AppHandle } from './app-handle'

interface ConfigPatch {
  conversionsRoot?: string
  convertOcrByDefault?: boolean
  ownerNames?: string[]
}

interface Dependencies {
  appHandle: AppHandle
  archiveRoot: () => string
  archiveAvailable: () => boolean
  othersArchiveRootResolved: () => string
  conversionsRootResolved: () => string | null
  readConfig: () => ConfigPatch
  writeConfig: (patch: ConfigPatch) => unknown
  cacheDir: () => string
  python: () => string
  pictureSearch: PictureSearchService | null
  sendLine: (line: string) => void
  sendConvertLine: (line: string) => void
}

export function install(deps: Dependencies): void {
  const { appHandle, archiveRoot, archiveAvailable, othersArchiveRootResolved, conversionsRootResolved, readConfig, writeConfig, cacheDir, python, pictureSearch, sendLine, sendConvertLine } = deps
  // --- archive ingest (Core A pipeline as streamed subprocesses) ---
  // Streamed feedback when import can't even start — otherwise the button "does nothing".
  const archiveMissingLine = (): void =>
    sendLine(`✕ No archive found at ${archiveRoot()} — it must contain a "registry" folder. Set a valid archive in Settings (⚙ → Archive).`)
  appHandle('ingest:pending', async () => {
    if (!archiveAvailable()) {
      archiveMissingLine()
      return { ok: false }
    }
    const r = await runIngest({ engineRoot: archiveRoot(), dataRoot: archiveRoot(), python: python(), mode: 'pending' }, sendLine)
    invalidateDeckMeta(cacheDir())
    pictureSearch?.pokeArchive()
    return r
  })
  // Pick the file/folder to import (returns the path so the panel can SHOW it before committing).
  appHandle('ingest:choose-path', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }]
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // Run the import against an already-chosen path (no dialog — the panel confirmed what + where).
  // library 'others' routes the data into the separate Others' Library store (Scenario A); the
  // ENGINE is always the user's ppt-archive (that's where Core A's tools/ live).
  appHandle('ingest:run-path', async (_e, targetPath: string, library?: 'mine' | 'others') => {
    if (!archiveAvailable()) {
      archiveMissingLine()
      return { ok: false }
    }
    if (!targetPath) {
      sendLine('✕ Pick a file or folder to import first.')
      return { ok: false }
    }
    const dataRoot = library === 'others' ? othersArchiveRootResolved() : archiveRoot()
    // checked again on use: the Others' Library never shares a folder with your own archive, however it was set
    if (library === 'others' && foldersOverlap(dataRoot, archiveRoot())) {
      sendLine(`✕ ${OVERLAP_REASON}`)
      return { ok: false }
    }
    if (library === 'others') sendLine(`→ Importing into your Others' Library (kept separate from your archive): ${dataRoot}`)
    const r = await runIngest({ engineRoot: archiveRoot(), dataRoot, python: python(), mode: 'path', targetPath }, sendLine)
    invalidateDeckMeta(cacheDir()) // new decks added → drop the cached index so they show without restart
    if (library !== 'others') pictureSearch?.pokeArchive()
    return r
  })
  appHandle('ingest:cancel', () => {
    cancelIngest()
    return true
  })

  // --- convert (sideband, throwaway): someone else's .pptx → a mechanical Outline folder,
  //     saved wherever the user picks. Never touches the archive registry or the vault. ---
  appHandle('settings:choose-conversions-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ conversionsRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  appHandle('settings:set-convert-ocr', (_e, on: boolean) => {
    writeConfig({ convertOcrByDefault: Boolean(on) })
    return Boolean(on)
  })
  // "My decks" owner names. Unset → computed from the OS account (never written until the user saves).
  appHandle('settings:get-owner-names', () => resolveOwnerNames(readConfig().ownerNames))
  appHandle('settings:set-owner-names', (_e, names: unknown) => {
    const cleaned = cleanOwnerNames(names)
    writeConfig({ ownerNames: cleaned.length > 0 ? cleaned : undefined }) // empty → back to the account default
    const resolved = resolveOwnerNames(readConfig().ownerNames)
    setOwnerNames(resolved.names) // ownership is part of the deck index → next load rescans
    return resolved
  })
  // Step 1: pick the source .pptx — returns its path so the panel SHOWS it before converting.
  appHandle('convert:choose-source', async () => {
    const pick = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }] })
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  })
  // Step 2: pick the destination folder, pre-filled from the source name + the conversionsRoot default.
  appHandle('convert:choose-dest', async (_e, sourcePath: string) => {
    const suggested = slugify(basename(sourcePath || '').replace(/\.(pptx|ppt)$/i, '')) || 'converted'
    const defDir = conversionsRootResolved()
    const defaultPath = join(defDir && existsSync(defDir) ? defDir : homedir(), suggested)
    const save = await dialog.showSaveDialog({ title: 'Save the converted Outline folder as…', buttonLabel: 'Choose', defaultPath })
    return save.canceled || !save.filePath ? null : save.filePath
  })
  // Step 3: run the conversion against the already-chosen source + destination (no dialogs here).
  appHandle('convert:run', async (_e, opts: { pptxPath: string; outDir: string; ocr: boolean }) => {
    if (!archiveAvailable()) {
      sendConvertLine('✕ Archive engine not found — set it in Settings (extraction needs Core A).')
      return { ok: false, error: 'archive unavailable' }
    }
    if (!opts?.pptxPath || !opts?.outDir) return { ok: false, error: 'pick a PowerPoint and a destination first' }
    try {
      if (existsSync(opts.outDir) && readdirSync(opts.outDir).length > 0) {
        const res = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Write here anyway'],
          defaultId: 0,
          cancelId: 0,
          message: `“${basename(opts.outDir)}” already exists and isn't empty. Write the converted Outline into it anyway?`
        })
        if (res.response !== 1) return { ok: false, cancelled: true }
      }
    } catch {
      /* stat race → proceed */
    }
    const r = await convertPptxToOutline({ archiveRoot: archiveRoot(), python: python(), pptxPath: opts.pptxPath, outDir: opts.outDir, ocr: Boolean(opts?.ocr) }, sendConvertLine)
    if (r.ok && r.outDir) {
      const outlineFile = join(r.outDir, `${slugify(basename(r.outDir)) || 'converted'}-outline.md`)
      shell.showItemInFolder(existsSync(outlineFile) ? outlineFile : r.outDir)
    }
    return r
  })
}
