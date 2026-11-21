// The one command registry (invariant 1). The menu bar, the ⌘/ cheat sheet, the Shortcuts page of the
// Settings window and the Search view's key handler all read this list; nothing else names a chord.
// Pure: no Electron, no React, so main, renderer, the CLI and tests share it.
//
// The Review and Triage screens keep their own screen-local keys (K, T, S, X, U, [ ] …): they reuse letters
// the Search view binds to other commands, and the registry has no per-screen scope, so registering them
// here would be chord collisions. They are listed in the cheat sheet as SCREEN_KEYS until the registry
// can scope commands to a screen.
import { chordFromEvent, defineRegistry, dispatchKey, type Bindings, type CommandDef, type KeyContext, type KeyLike, type MenuDecl } from '@app-patterns/commands'

export type Group = 'Find' | 'Selection' | 'Copy' | 'Show' | 'Library' | 'Go' | 'Move'

/** What `available` looks at. The renderer owns it and tells main so the menu can grey items out. */
export type CommandContext = { view: 'search' | 'review' | 'triage'; hasItems: boolean; hasActive: boolean }
export const NO_CONTEXT: CommandContext = { view: 'search', hasItems: false, hasActive: false }

const onSearch = (c: CommandContext): string | null => (c.view === 'search' ? null : 'Only on the Search screen')
const needsActive = (c: CommandContext): string | null => onSearch(c) ?? (c.hasActive ? null : 'Select a slide or image first')
const needsItems = (c: CommandContext): string | null => onSearch(c) ?? (c.hasItems ? null : 'Nothing to select yet')
const MOVE = 'Arrow, Enter and Escape keys move and open; they are not menu actions'

const DEFS: CommandDef<Group, CommandContext>[] = [
  { id: 'find', group: 'Find', label: 'Search the archive', key: '⌘F', icon: 'search', fixed: true, typing: true, available: onSearch },
  { id: 'actions', group: 'Selection', label: 'Actions on the selection', key: '⌘K', icon: 'zap', fixed: true, typing: true, available: needsItems },
  { id: 'inspector', group: 'Selection', label: 'Show or hide details', key: 'I', icon: 'panel-right', available: needsItems },
  { id: 'open-item', group: 'Move', label: 'Open full size', key: '↵', icon: 'maximize-2', noMenu: true, noMenuReason: MOVE },
  { id: 'move-left', group: 'Move', label: 'Previous item', key: '←', icon: 'arrow-left', noMenu: true, noMenuReason: MOVE },
  { id: 'move-right', group: 'Move', label: 'Next item', key: '→', icon: 'arrow-right', noMenu: true, noMenuReason: MOVE },
  { id: 'move-up', group: 'Move', label: 'Up a row', key: '↑', icon: 'arrow-up', noMenu: true, noMenuReason: MOVE },
  { id: 'move-down', group: 'Move', label: 'Down a row', key: '↓', icon: 'arrow-down', noMenu: true, noMenuReason: MOVE },
  { id: 'dismiss', group: 'Move', label: 'Close or go back', key: 'Esc', icon: 'x', typing: true, noMenu: true, noMenuReason: MOVE },
  // ⌘C is the system's Copy: with no text selected, Edit › Copy copies the selected image (App.tsx copy handler)
  { id: 'copy-image', group: 'Copy', label: 'Copy image (WebP)', key: '', icon: 'copy', available: needsActive },
  { id: 'copy-image-png', group: 'Copy', label: 'Copy image as PNG', key: '⌘⇧C', icon: 'image', available: needsActive },
  { id: 'copy-text', group: 'Copy', label: 'Copy text', key: 'T', icon: 'type', available: needsActive },
  { id: 'copy-structure', group: 'Copy', label: 'Copy structure', key: 'J', icon: 'braces', available: needsActive },
  { id: 'copy-ref', group: 'Copy', label: 'Copy reference', key: 'R', icon: 'link', available: needsActive },
  { id: 'reveal', group: 'Selection', label: 'Show in Finder', key: 'F', icon: 'folder-search', available: needsActive },
  { id: 'context', group: 'Selection', label: 'See in context', key: 'X', icon: 'presentation', available: needsActive },
  { id: 'show-slides', group: 'Show', label: 'Show slides', key: '1', icon: 'square', available: onSearch },
  { id: 'show-images', group: 'Show', label: 'Show images', key: '2', icon: 'image', available: onSearch },
  { id: 'show-decks', group: 'Show', label: 'Show presentations', key: '3', icon: 'layers', available: onSearch },
  { id: 'group-by-deck', group: 'Show', label: 'Group by presentation', key: 'G', icon: 'group', available: onSearch },
  { id: 'toggle-clusters', group: 'Show', label: 'Group near-identical slides', key: 'C', icon: 'copy-check', available: onSearch },
  { id: 'go-search', group: 'Go', label: 'Search', key: '', icon: 'search' },
  { id: 'go-review', group: 'Go', label: 'Review', key: '', icon: 'check-check' },
  { id: 'go-triage', group: 'Go', label: 'Triage', key: '', icon: 'pickaxe' },
  { id: 'open-auto-sorting', group: 'Go', label: 'Auto sorting', key: '', icon: 'sparkles' },
  { id: 'stats', group: 'Library', label: 'Your presentations in numbers', key: 'S', icon: 'bar-chart-3', available: onSearch },
  { id: 'import', group: 'Library', label: 'Import PowerPoint…', key: 'O', icon: 'download', available: onSearch },
  { id: 'convert', group: 'Library', label: 'Convert a presentation to an Outline…', key: '', icon: 'arrow-left-right' }
]

// The frame commands (settings, cheat, export-settings, import-settings) are added by the package.
export const registry = defineRegistry<Group, CommandContext>(DEFS, {
  overlayIds: ['dismiss', 'settings', 'cheat']
})

/** App menus; the frame supplies App, Edit, View, Window and Help. */
export const MENUS: MenuDecl<Group>[] = [
  { label: 'Library', groups: ['Library'] },
  { label: 'Selection', groups: ['Selection', 'Copy'] },
  { label: 'Show', groups: ['Show'] },
  { label: 'Go', groups: ['Find', 'Go'] }
]

/**
 * Keys that also run a command although the registry binds another chord: habits from before the
 * registry. `/` focuses search (⌘F), `?` opens the cheat sheet (⌘/), Space shows details (I).
 * Chord (as `chordFromEvent` writes it) to the command and the text the cheat sheet shows.
 */
export const KEY_ALIASES: Readonly<Record<string, { id: string; show: string }>> = {
  '/': { id: 'find', show: '/' },
  '⇧/': { id: 'cheat', show: '?' },
  Space: { id: 'inspector', show: 'Space' }
}

/** Alias keys for one command, as the cheat sheet shows them. */
export function aliasesOf(id: string): string[] {
  return Object.values(KEY_ALIASES).flatMap((a) => (a.id === id ? [a.show] : []))
}

/** The command a key press runs: the registry's binding, else an alias (outside text fields and overlays). */
export function commandForEvent(e: KeyLike & { key?: string }, bindings: Bindings, ctx: KeyContext): string | null {
  const id = dispatchKey(registry, e, bindings, ctx)
  if (id || ctx.inField || ctx.overlay) return id
  const chord = e.key === '?' ? '⇧/' : e.key === ' ' ? 'Space' : chordFromEvent(e)
  return (chord && KEY_ALIASES[chord]?.id) || null
}

/** Commands the main process runs itself (the Settings window host); the rest go to the renderer. */
export const MAIN_COMMANDS: ReadonlySet<string> = new Set(['settings', 'export-settings', 'import-settings'])

/** The Review and Triage screens' own keys (not commands yet; see the note at the top). For the cheat sheet. */
export const SCREEN_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Review', 'K keep · T throw away · ↓ skip · ↑ back · ← → step through answered · ⌘Z undo · both piles: arrows, Tab, Esc'],
  ['Triage', 'Space or S select · U unselect · X or E exclude · [ ] page · / search · ⌘Z undo']
]

/** A tooltip with the command's effective chord: "Import PowerPoint (O)". Nothing hand-copies a chord. */
export function withChord(bindings: Readonly<Record<string, string>>, id: string, text: string): string {
  const chord = bindings[id]
  return chord ? `${text} (${chord})` : text
}
