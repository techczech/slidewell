// The registry, schema, key slots and settings CLI: SKILL.md's per-app tests 1–5 at their seams.
import { afterEach, describe, expect, test } from 'vitest'
import { SLOT_MESSAGES } from '@app-patterns/settings-electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMenuTemplate, RESERVED_ESTATE, validateMenuCoverage } from '@app-patterns/commands'
import { commandsAdapter, exportFile, emptyState, NOT_IMPORTABLE, previewImport, searchSettings } from '@app-patterns/settings'
import { aliasesOf, commandForEvent, MENUS, registry } from '../src/shared/commands'
import { legacyFromPrefs, R2_ENDPOINT_RULE, schema, SECRET_KEYS, splitLegacyPatch } from '../src/shared/settings-schema'
import { foldersOverlap, OVERLAP_REASON } from '../src/main/settings-rules'
import { keySlots, type KeyBackend } from '../src/main/key-slots'
import { run } from '../src/cli/settings-cli'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const folder = (): string => { const d = mkdtempSync(join(tmpdir(), 'sw-cli-')); dirs.push(d); return d }

describe('command registry', () => {
  const bindings = registry.bindingsOf({})
  test('every command lands in a menu or is noMenu with a reason', () => {
    expect(validateMenuCoverage(registry, MENUS)).toEqual([])
    for (const d of registry.defs) if (d.noMenu) expect(d.noMenuReason).toBeTruthy()
  })
  test('zero collisions and reserved chords go only to their surface', () => {
    const seen = new Map<string, string>()
    for (const [id, chord] of Object.entries(bindings)) {
      if (!chord) continue
      expect(seen.get(chord), `${chord} on ${id} and ${seen.get(chord)}`).toBeUndefined()
      seen.set(chord, id)
    }
    expect(seen.get('⌘,')).toBe('settings')
    expect(seen.get('⌘/')).toBe('cheat')
    expect(seen.get('⌘K')).toBe('actions')
    expect(seen.get('⌘F')).toBe('find')
    for (const chord of ['⌘⇧P', '⌘⇧K', '⌘P', '⌘⇧F']) expect(seen.has(chord), `${chord} (${RESERVED_ESTATE[chord]}) left unbound`).toBe(false)
  })
  test('the old single-key habits still work and ? opens the cheat sheet', () => {
    const ctx = { inField: false, onControl: false, overlay: false }
    expect(commandForEvent({ key: 't', code: 'KeyT', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, bindings, ctx)).toBe('copy-text')
    expect(commandForEvent({ key: '?', code: 'Slash', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, bindings, ctx)).toBe('cheat')
    expect(commandForEvent({ key: '/', code: 'Slash', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, bindings, ctx)).toBe('find')
    expect(commandForEvent({ key: 't', code: 'KeyT', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, bindings, { ...ctx, inField: true })).toBeNull()
    expect(aliasesOf('inspector')).toEqual(['Space'])
  })
  test('menu items show the effective chord, overrides included', () => {
    const over = registry.bindingsOf({ 'copy-text': '⌥T' })
    const menu = buildMenuTemplate({ appName: 'SlideWell', registry, menus: MENUS, bindings: over, ctx: { view: 'search', hasItems: true, hasActive: true }, run: () => {} })
    const items = menu.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : []))
    const copy = items.find((i) => i.label === 'Copy text')
    expect(copy?.accelerator).toBe('Alt+T')
    expect(items.find((i) => typeof i.label === 'string' && i.label.startsWith('Settings'))?.accelerator).toBe('Cmd+,')
  })
})

describe('settings schema', () => {
  test('every setting is found by search under its section', () => {
    for (const d of schema.settings) {
      const hits = searchSettings(schema.settings, schema.sections, d.label)
      expect(hits.some((h) => h.key === d.key), d.key).toBe(true)
    }
  })
  test('keys are secret settings and are never in an export', () => {
    for (const k of SECRET_KEYS) expect(schema.def(k)?.type).toBe('secret')
    const file = exportFile(emptyState('slidewell'), { appVersion: 'x', hostName: 'Mac', now: () => 0, schema, commands: { isCommand: () => false, defaultChord: () => '', resolve: () => ({ bindings: {}, rejected: [] }) } })
    for (const k of SECRET_KEYS) expect(JSON.stringify(file)).not.toContain(k)
  })
  test('main readers see the old shape; old-shape writes split into settings and config.json', () => {
    const p = legacyFromPrefs({ 'library.archiveRoot': '/a', 'storage.wellBackend': 'r2', 'library.ownerNames': 'A, B' })
    expect(p.archiveRoot).toBe('/a')
    expect(p.othersArchiveRoot).toBeUndefined()
    expect(p.ownerNames).toEqual(['A', 'B'])
    expect(p.storage?.well?.backend).toBe('r2')
    expect(p.r2?.bucket).toBe('ppt-archive-media')
    expect(p.sorterAutoRetrain).toBe(true)
    const split = splitLegacyPatch({ r2: { accountId: 'x', secretEnc: 'C' }, windowBounds: { width: 1, height: 1 }, pictureSearch: { includeWell: true, paused: false } })
    expect(split.prefs).toEqual({ 'storage.r2AccountId': 'x', 'library.includeWellInPictureSearch': true })
    expect(split.rest).toEqual({ r2: { secretEnc: 'C' }, windowBounds: { width: 1, height: 1 }, pictureSearch: { paused: false } })
  })
})

describe('key slots', () => {
  const backend = (saved: boolean, log: string[]): KeyBackend => ({ label: 'K', has: () => saved, set: (v) => { log.push(`set:${v.length}`); return { ok: v.length > 3 } }, remove: () => log.push('remove') })
  test('status only, never a value; a refused save says nothing of the backend', () => {
    const log: string[] = []
    const slots = keySlots({ 'storage.r2AccessKeyId': backend(true, log), 'storage.r2SecretAccessKey': backend(false, log), 'sorting.openaiKey': backend(false, log), 'sorting.anthropicKey': backend(true, log) }, () => true)
    const list = slots.list() as { id: string; status: string; last4?: string }[]
    expect(list.map((s) => s.status)).toEqual(['connected', 'missing', 'missing', 'connected'])
    expect(list.every((s) => s.last4 === undefined)).toBe(true)
    expect(slots.set('sorting.openaiKey', '  ab  ')).toEqual({ ok: false, error: 'refused' })
    expect(slots.set('sorting.openaiKey', 'sk-longer-key')).toEqual({ ok: true })
    expect(slots.set('nope', 'x')).toEqual({ ok: false, error: 'unknown' })
    expect(slots.remove('storage.r2AccessKeyId')).toEqual({ ok: true })
    expect(log).toEqual(['set:2', 'set:13', 'remove'])
  })
  test('a key of the wrong shape gets the package shape message, never the key', () => {
    const shape = 'That does not look like an Anthropic API key (they start with sk-ant-).'
    const typed = 'sk-proj-SECRETVALUE1234567890'
    const slots = keySlots({ 'storage.r2AccessKeyId': backend(false, []), 'storage.r2SecretAccessKey': backend(false, []), 'sorting.openaiKey': backend(false, []), 'sorting.anthropicKey': { label: 'K', has: () => false, set: () => ({ ok: false, error: shape, shape: true }), remove: () => undefined } }, () => true)
    const r = slots.set('sorting.anthropicKey', typed)
    expect(r).toEqual({ ok: false, error: SLOT_MESSAGES.shape })
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE')
  })
  test('without the keychain nothing is saved and saved keys show a problem', () => {
    const log: string[] = []
    const slots = keySlots({ 'storage.r2AccessKeyId': backend(true, log), 'storage.r2SecretAccessKey': backend(false, log), 'sorting.openaiKey': backend(false, log), 'sorting.anthropicKey': backend(false, log) }, () => false)
    expect((slots.list() as { status: string }[])[0].status).toBe('problem')
    expect(slots.set('sorting.openaiKey', 'sk-longer-key')).toEqual({ ok: false, error: 'keychain' })
    expect(log).toEqual([])
  })
})

describe('settings CLI', () => {
  const io = () => { const out: string[] = []; return { out, io: { stdout: (t: string) => void out.push(t), stderr: () => {} } } }
  test('set, get, reset and changes, logged as the agent', async () => {
    const dir = folder()
    const a = io()
    expect(await run(['set', 'sorting.period', '30d', '--agent', 'Claude Code', '--json'], a.io, dir)).toBe(0)
    const b = io()
    expect(await run(['get', 'sorting.period'], b.io, dir)).toBe(0)
    expect(b.out.join('').trim()).toBe('30d')
    const c = io()
    await run(['changes', '--json'], c.io, dir)
    const changes = JSON.parse(c.out.join('')).changes
    expect(changes[0]).toMatchObject({ key: 'sorting.period', from: 'all', to: '30d', who: { kind: 'agent', name: 'Claude Code' } })
    expect(await run(['reset', 'sorting.period'], io().io, dir)).toBe(0)
    expect(await run(['set', 'sorting.openaiKey', 'sk-x'], io().io, dir)).toBe(2)
  })
  test('export never carries a key; import previews, then applies as one batch', async () => {
    const dir = folder()
    await run(['set', 'library.convertOcr', 'on'], io().io, dir)
    const file = join(dir, 'out.json')
    expect(await run(['export', file], io().io, dir)).toBe(0)
    const text = readFileSync(file, 'utf8')
    for (const k of SECRET_KEYS) expect(text).not.toContain(k)
    const other = folder()
    expect(await run(['import', file], io().io, other)).toBe(3)
    expect(await run(['import', file, '--yes'], io().io, other)).toBe(0)
    const g = io()
    await run(['get', 'library.convertOcr'], g.io, other)
    expect(g.out.join('').trim()).toBe('true')
  })
  test('run before the app, the CLI migrates config.json first instead of hiding it', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ archiveRoot: '/tmp/x', windowBounds: { width: 1, height: 1 } }))
    const g = io()
    expect(await run(['get', 'library.archiveRoot'], g.io, dir)).toBe(0)
    expect(g.out.join('').trim()).toBe('/tmp/x')
  })

  const ioErr = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } } }
  test('the Others’ Library may never overlap your archive, set from either side, by set or by import', async () => {
    const dir = folder()
    const mine = join(dir, 'mine')
    expect(await run(['set', 'library.archiveRoot', mine], io().io, dir)).toBe(0)
    for (const bad of [mine, join(mine, 'others'), dir]) {
      const r = ioErr()
      expect(await run(['set', 'library.othersRoot', bad], r.io, dir)).not.toBe(0)
      expect(r.err.join('') + r.out.join('')).toContain(OVERLAP_REASON)
    }
    const others = join(dir, 'others')
    expect(await run(['set', 'library.othersRoot', others], io().io, dir)).toBe(0)
    const back = ioErr()
    expect(await run(['set', 'library.archiveRoot', join(others, 'inside')], back.io, dir)).not.toBe(0) // the other direction
    expect(back.err.join('') + back.out.join('')).toContain(OVERLAP_REASON)
    const g = io()
    await run(['get', 'library.archiveRoot'], g.io, dir)
    expect(g.out.join('').trim()).toBe(mine)
    // an import that would make them overlap is refused as a whole
    const file = join(dir, 'overlap.json')
    writeFileSync(file, JSON.stringify({ format: 'bridle-settings-export', version: 1, app: 'slidewell', appVersion: '0', exportedFrom: 'x', exportedAt: '2026-10-20T00:00:00.000Z', settings: { 'library.othersRoot': join(mine, 'sub') }, keys: {} }))
    const imp = ioErr()
    expect(await run(['import', file, '--yes'], imp.io, dir)).not.toBe(0)
    const o = io()
    await run(['get', 'library.othersRoot'], o.io, dir)
    expect(o.out.join('').trim()).toBe(others)
  })
  test('overlap follows symbolic links and counts a root folder as holding everything', async () => {
    const dir = folder()
    const mine = join(dir, 'mine')
    mkdirSync(mine)
    const link = join(dir, 'link-to-mine')
    symlinkSync(mine, link)
    expect(foldersOverlap(mine, link)).toBe(true)
    expect(foldersOverlap(mine, join(link, 'not-yet', 'made'))).toBe(true) // resolved through its nearest existing parent
    expect(foldersOverlap('/', '/tmp/mine')).toBe(true)
    expect(foldersOverlap('/tmp/mine', '/')).toBe(true)
    expect(foldersOverlap(join(dir, 'a'), join(dir, 'ab'))).toBe(false)
    expect(foldersOverlap(join(dir, 'a'), join(dir, '..a'))).toBe(false)
    expect(await run(['set', 'library.archiveRoot', mine], io().io, dir)).toBe(0)
    const r = ioErr()
    expect(await run(['set', 'library.othersRoot', link], r.io, dir)).not.toBe(0)
    expect(r.err.join('') + r.out.join('')).toContain(OVERLAP_REASON)
  })
  test('overlap follows a symbolic link before a `..` after it (other/link/.. with link → mine/child is mine)', async () => {
    const dir = folder()
    const mine = join(dir, 'mine')
    mkdirSync(join(mine, 'child'), { recursive: true })
    mkdirSync(join(dir, 'other'))
    symlinkSync(join(mine, 'child'), join(dir, 'other', 'link'))
    const sneaky = join(dir, 'other', 'link') + '/..'
    expect(foldersOverlap(mine, sneaky)).toBe(true)
    expect(foldersOverlap(mine, sneaky + '/not-yet')).toBe(true) // through the nearest existing parent too
    expect(foldersOverlap(mine, join(dir, 'other'))).toBe(false)
    expect(await run(['set', 'library.archiveRoot', mine], io().io, dir)).toBe(0)
    const r = ioErr()
    expect(await run(['set', 'library.othersRoot', sneaky], r.io, dir)).not.toBe(0)
    expect(r.err.join('') + r.out.join('')).toContain(OVERLAP_REASON)
  })
  test('what to run and where to send data are never imported; the R2 endpoint must be Cloudflare’s', async () => {
    const from = { ...emptyState(schema.app), settings: { 'advanced.pythonPath': '/tmp/evil/python', 'library.archiveRoot': '/tmp/evil/archive', 'storage.r2Prefix': 'elsewhere', 'storage.r2Endpoint': 'https://acc.r2.cloudflarestorage.com', 'storage.r2Bucket': 'b', 'storage.r2AccountId': 'a', 'library.convertOcr': true } }
    const file = exportFile(from, { appVersion: '0', hostName: 'x', now: 0, schema, commands: commandsAdapter(registry) })
    const preview = previewImport(emptyState(schema.app), file, { schema, commands: commandsAdapter(registry) })
    expect(preview.changes.map((c) => c.key)).toEqual(['library.convertOcr'])
    const skipped = Object.fromEntries(preview.skipped.map((x) => [(x as { key?: string }).key, (x as { reason?: string }).reason]))
    for (const k of ['advanced.pythonPath', 'library.archiveRoot', 'storage.r2Prefix', 'storage.r2Endpoint', 'storage.r2Bucket', 'storage.r2AccountId']) expect(skipped[k]).toBe(NOT_IMPORTABLE)
    const dir = folder()
    const bad = ioErr()
    expect(await run(['set', 'storage.r2Endpoint', 'https://evil.example.com'], bad.io, dir)).not.toBe(0)
    expect(bad.err.join('') + bad.out.join('')).toContain(R2_ENDPOINT_RULE)
    expect(await run(['set', 'storage.r2Endpoint', 'http://acc.r2.cloudflarestorage.com'], io().io, dir)).not.toBe(0)
    expect(await run(['set', 'storage.r2Endpoint', 'https://acc.eu.r2.cloudflarestorage.com'], io().io, dir)).toBe(0)
  })
})
