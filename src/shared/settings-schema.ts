// The one settings schema (invariant 2) and the bridge to the file SlideWell used before shared settings:
// userData/config.json, which mixed preferences with app state (window size, last sort, retrain records,
// lists, the cloud step's agreements) and the safeStorage ciphertext of four keys.
//
// Preferences move to userData/settings.json (the shared store). config.json is left as the old version's
// file (its preferences stay as they were, so it is the backup); the app keeps using it for state, lists,
// the cloud step (its switches are gated by a consent dialog the schema cannot express) and the key
// ciphertext, which is already encrypted with safeStorage and is exposed to the window only as key slots.
//
// Pure: no Electron, no node:, so main, renderer, the CLI and tests share it.
import { defineSchema, type Migrated, type SettingValue } from '@app-patterns/settings'

export const APP_ID = 'slidewell'
export const APP_NAME = 'SlideWell'

const PATH_HELP_DEFAULT = 'Empty means the default location.'

/**
 * Settings that name something to run, somewhere to send data, or a folder that becomes a code path are
 * declared `importable: false`, so an import never applies them: a settings file from elsewhere must not choose
 * the program SlideWell runs or where uploads go. They are set on each Mac: the Python, the archive folder
 * (its tools/ are run), and the R2 account, endpoint, bucket and prefix.
 */

export const R2_ENDPOINT_RULE = 'The R2 endpoint must be an https address ending in .r2.cloudflarestorage.com.'
/** Empty (worked out from the account ID) or https://….r2.cloudflarestorage.com, with no user name or password. */
export function checkR2Endpoint(v: unknown): string | null {
  if (v === '') return null
  if (typeof v !== 'string') return R2_ENDPOINT_RULE
  try {
    const u = new URL(v)
    const host = u.hostname.toLowerCase()
    if (u.protocol !== 'https:' || u.username || u.password || !host.endsWith('.r2.cloudflarestorage.com')) return R2_ENDPOINT_RULE
    return null
  } catch {
    return R2_ENDPOINT_RULE
  }
}

export const schema = defineSchema({
  app: APP_ID,
  sections: [
    { id: 'library', label: 'Library', icon: 'library' },
    { id: 'capture', label: 'Screenshots', icon: 'camera' },
    { id: 'sorting', label: 'Sorting', icon: 'sparkles' },
    { id: 'storage', label: 'Storage', icon: 'cloud' },
    { id: 'advanced', label: 'Advanced', icon: 'wrench' }
  ],
  settings: [
    {
      key: 'library.archiveRoot', label: 'Archive folder', section: 'library', group: 'Folders', type: 'path', default: '',
      help: `The Core A archive with your presentations. ${PATH_HELP_DEFAULT} (~/gitrepos/05_ppt-tools/ppt-archive)`,
      // Its tools/ run: it is the import's working folder and PYTHONPATH (ingest.ts) and holds the OCR helper.
      importable: false
    },
    {
      key: 'library.othersRoot', label: 'Others’ Library folder', section: 'library', group: 'Folders', type: 'path', default: '',
      help: `A separate archive for other people’s presentations; never merged into yours. ${PATH_HELP_DEFAULT} (~/SlideWell/others-library)`
    },
    {
      key: 'library.wellRoot', label: 'Well folder', section: 'library', group: 'Folders', type: 'path', default: '',
      help: `Where SlideWell keeps the images you add. ${PATH_HELP_DEFAULT} (~/SlideWell/well)`
    },
    {
      key: 'library.vaultRoot', label: 'TalkWeaver vault', section: 'library', group: 'Folders', type: 'path', default: '',
      help: 'TalkWeaver’s vault, whose images are indexed in place. Empty means the vault TalkWeaver itself uses.'
    },
    {
      key: 'library.conversionsRoot', label: 'Conversions folder', section: 'library', group: 'Converting', type: 'path', default: '',
      help: 'Where a presentation converted to an Outline is saved by default. Empty means you are asked each time.'
    },
    {
      key: 'library.convertOcr', label: 'Read text in images when converting', section: 'library', group: 'Converting', type: 'toggle', default: false,
      help: 'When converting someone’s presentation, recognise text inside images (macOS Vision) and put it into the Outline.'
    },
    {
      key: 'library.ownerNames', label: 'Your names as presentation author', section: 'library', group: 'My presentations', type: 'text', default: '',
      help: 'Comma-separated. A presentation counts as yours when its author contains any of these names; accents and case are ignored. Empty means the names on your Mac account.'
    },
    {
      key: 'library.includeWellInPictureSearch', label: 'Search your own images by meaning', section: 'library', group: 'Picture search', type: 'toggle', default: true,
      help: 'Include the images in the well when picture search indexes by meaning.'
    },
    {
      key: 'capture.triageRoot', label: 'Triage source folder', section: 'capture', group: 'Folders', type: 'path', default: '',
      help: 'The screenshots folder Triage reads. SlideWell only reads it; it never moves or changes the originals. Empty means none chosen yet.'
    },
    {
      key: 'capture.leaveOutNotOnMac', label: 'Leave out screenshots that are not on this Mac', section: 'capture', group: 'Review', type: 'toggle', default: false,
      help: 'Screenshots that are only in the cloud stay out of Review and sorting until they are downloaded.'
    },
    {
      key: 'sorting.period', label: 'Sort screenshots from', section: 'sorting', group: 'Sorting on this Mac', type: 'choice', default: 'all',
      options: [
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
        { value: '90d', label: 'Last 90 days' },
        { value: 'all', label: 'Everything' }
      ],
      help: 'The period both sort buttons work on. The nightly sort ignores it.'
    },
    {
      key: 'sorting.autoRetrain', label: 'Retrain after every ten answers', section: 'sorting', group: 'Teaching the sorter', type: 'toggle', default: true,
      help: 'The sorter learns from your answers by itself.'
    },
    {
      key: 'sorting.autoRetrainOnBattery', label: 'Also retrain on battery', section: 'sorting', group: 'Teaching the sorter', type: 'toggle', default: false,
      help: 'Retraining uses the processor for a minute or two.'
    },
    {
      key: 'sorting.openaiKey', label: 'OpenAI key', section: 'accounts', type: 'secret', default: null,
      help: 'For Luna, which helps with screenshots the sorter is unsure about.'
    },
    {
      key: 'sorting.anthropicKey', label: 'Anthropic key', section: 'accounts', type: 'secret', default: null,
      help: 'For Haiku, which helps with screenshots the sorter is unsure about.'
    },
    {
      key: 'storage.r2AccountId', label: 'R2 account ID', section: 'storage', group: 'R2 cloud storage', type: 'text', default: '',
      help: 'Your Cloudflare account ID.', importable: false
    },
    {
      key: 'storage.r2Bucket', label: 'R2 bucket', section: 'storage', group: 'R2 cloud storage', type: 'text', default: 'ppt-archive-media',
      help: 'A private bucket; SlideWell signs every request.', importable: false
    },
    {
      key: 'storage.r2Prefix', label: 'R2 key prefix', section: 'storage', group: 'R2 cloud storage', type: 'text', default: 'slidewell',
      help: 'Folder-like prefix inside the bucket.', importable: false
    },
    {
      key: 'storage.r2Endpoint', label: 'R2 endpoint', section: 'storage', group: 'R2 cloud storage', type: 'text', default: '',
      help: 'Empty means the endpoint worked out from the account ID.',
      validate: (v) => checkR2Endpoint(v), importable: false
    },
    {
      key: 'storage.r2AccessKeyId', label: 'R2 access key ID', section: 'accounts', type: 'secret', default: null,
      help: 'S3 access key for the R2 bucket.'
    },
    {
      key: 'storage.r2SecretAccessKey', label: 'R2 secret access key', section: 'accounts', type: 'secret', default: null,
      help: 'S3 secret for the R2 bucket.'
    },
    ...(['archive', 'others', 'well'] as const).map((store) => ({
      key: `storage.${store}Backend`,
      label: store === 'archive' ? 'Archive' : store === 'others' ? 'Others’ Library' : 'Well',
      section: 'storage',
      group: 'Where each library is kept',
      type: 'choice' as const,
      default: 'local',
      options: [
        { value: 'local', label: 'This Mac only' },
        { value: 'r2', label: 'This Mac and an R2 backup' }
      ],
      help: 'With an R2 backup the full copy stays on this Mac and is mirrored to R2 when you sync, so another Mac can fetch it.'
    })),
    {
      key: 'advanced.pythonPath', label: 'Python', section: 'advanced', type: 'path', default: '',
      help: 'The Python that runs Core A’s import tools. Empty means the one SlideWell finds.', importable: false
    }
  ]
})

/** Slot ids (the `secret` settings) and where config.json keeps each one's safeStorage ciphertext. */
export const SECRET_KEYS = ['storage.r2AccessKeyId', 'storage.r2SecretAccessKey', 'sorting.openaiKey', 'sorting.anthropicKey'] as const
export type SecretKey = (typeof SECRET_KEYS)[number]

/** The part of the old config.json that holds preferences (what moves to settings.json). */
export type LegacyPrefs = {
  archiveRoot?: string
  othersArchiveRoot?: string
  wellRoot?: string
  vaultRoot?: string
  conversionsRoot?: string
  convertOcrByDefault?: boolean
  ownerNames?: string[]
  screenshotRoot?: string
  reviewLeaveOutNotOnMac?: boolean
  sorterPeriod?: string
  sorterAutoRetrain?: boolean
  sorterAutoRetrainOnBattery?: boolean
  pythonPath?: string
  pictureSearch?: { includeWell?: boolean; paused?: boolean }
  r2?: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyIdEnc?: string; secretEnc?: string }
  storage?: Partial<Record<'archive' | 'others' | 'well', { backend?: 'local' | 'r2' }>>
}

type Rec = Record<string, unknown>
const isRec = (x: unknown): x is Rec => Boolean(x) && typeof x === 'object' && !Array.isArray(x)

const FLAT: ReadonlyArray<readonly [keyof LegacyPrefs, string]> = [
  ['archiveRoot', 'library.archiveRoot'],
  ['othersArchiveRoot', 'library.othersRoot'],
  ['wellRoot', 'library.wellRoot'],
  ['vaultRoot', 'library.vaultRoot'],
  ['conversionsRoot', 'library.conversionsRoot'],
  ['convertOcrByDefault', 'library.convertOcr'],
  ['screenshotRoot', 'capture.triageRoot'],
  ['reviewLeaveOutNotOnMac', 'capture.leaveOutNotOnMac'],
  ['sorterPeriod', 'sorting.period'],
  ['sorterAutoRetrain', 'sorting.autoRetrain'],
  ['sorterAutoRetrainOnBattery', 'sorting.autoRetrainOnBattery'],
  ['pythonPath', 'advanced.pythonPath']
]
const R2_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['accountId', 'storage.r2AccountId'],
  ['endpoint', 'storage.r2Endpoint'],
  ['bucket', 'storage.r2Bucket'],
  ['prefix', 'storage.r2Prefix']
]
const STORES = ['archive', 'others', 'well'] as const

/** Every config.json field (top level) that holds a preference; `r2`, `pictureSearch` and `storage` only in part. */
export const PREF_FIELDS: ReadonlySet<string> = new Set([...FLAT.map(([f]) => f), 'ownerNames', 'storage'])

/**
 * The settings (by schema key) an old config.json holds. Only fields that are present are returned: an
 * absent field is the default and produces no change entry. Values are passed on as they are; the
 * loader repairs an invalid one with an INVALID_SAVED_VALUE entry.
 */
export function prefsFromLegacy(cfg: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRec(cfg)) return out
  for (const [field, key] of FLAT) if (cfg[field] !== undefined && cfg[field] !== null) out[key] = cfg[field]
  if (Array.isArray(cfg['ownerNames'])) out['library.ownerNames'] = (cfg['ownerNames'] as unknown[]).filter((n) => typeof n === 'string').join(', ')
  const pic = cfg['pictureSearch']
  if (isRec(pic) && pic['includeWell'] !== undefined) out['library.includeWellInPictureSearch'] = pic['includeWell']
  const r2 = cfg['r2']
  if (isRec(r2)) for (const [field, key] of R2_FIELDS) if (typeof r2[field] === 'string' && r2[field] !== '') out[key] = r2[field]
  const storage = cfg['storage']
  if (isRec(storage)) {
    for (const s of STORES) {
      const b = storage[s]
      if (isRec(b) && b['backend'] !== undefined) out[`storage.${s}Backend`] = b['backend']
    }
  }
  return out
}

/** The current settings (stored non-defaults over schema defaults) in config.json's old shape, for main's readers. */
export function legacyFromPrefs(stored: Readonly<Record<string, unknown>>): LegacyPrefs {
  const v = (key: string): SettingValue => (key in stored ? (stored[key] as SettingValue) : (schema.def(key)?.default as SettingValue))
  const str = (key: string): string | undefined => {
    const x = v(key)
    return typeof x === 'string' && x !== '' ? x : undefined
  }
  const out: LegacyPrefs = {}
  for (const [field, key] of FLAT) {
    const def = schema.def(key)
    if (def?.type === 'toggle') (out as Rec)[field] = v(key) === true
    else (out as Rec)[field] = str(key)
  }
  const owners = str('library.ownerNames')
  out.ownerNames = owners ? owners.split(/[,;\n]/).map((n) => n.trim()).filter(Boolean) : undefined
  out.pictureSearch = { includeWell: v('library.includeWellInPictureSearch') === true }
  out.r2 = { accountId: str('storage.r2AccountId'), endpoint: str('storage.r2Endpoint'), bucket: str('storage.r2Bucket'), prefix: str('storage.r2Prefix') }
  out.storage = {}
  for (const s of STORES) out.storage[s] = { backend: v(`storage.${s}Backend`) === 'r2' ? 'r2' : 'local' }
  return out
}

/** A patch in config.json's old shape split into setting changes (by schema key) and what stays in config.json. */
export function splitLegacyPatch(patch: Rec): { prefs: Record<string, SettingValue>; rest: Rec } {
  const prefs: Record<string, SettingValue> = {}
  const rest: Rec = {}
  for (const [field, value] of Object.entries(patch)) {
    const flat = FLAT.find(([f]) => f === field)
    if (flat) {
      const def = schema.def(flat[1])
      prefs[flat[1]] = def?.type === 'toggle' ? value === true : typeof value === 'string' ? value : ''
    } else if (field === 'ownerNames') {
      prefs['library.ownerNames'] = Array.isArray(value) ? value.filter((n) => typeof n === 'string').join(', ') : ''
    } else if (field === 'pictureSearch' && isRec(value)) {
      const { includeWell, ...state } = value
      if (includeWell !== undefined) prefs['library.includeWellInPictureSearch'] = includeWell === true
      if (Object.keys(state).length > 0) rest['pictureSearch'] = state
    } else if (field === 'r2' && isRec(value)) {
      const keep: Rec = {}
      for (const [k, x] of Object.entries(value)) {
        const r2 = R2_FIELDS.find(([f]) => f === k)
        if (r2) prefs[r2[1]] = typeof x === 'string' ? x : ''
        else keep[k] = x
      }
      if (Object.keys(keep).length > 0) rest['r2'] = keep
    } else if (field === 'storage' && isRec(value)) {
      for (const s of STORES) {
        const b = value[s]
        if (isRec(b)) prefs[`storage.${s}Backend`] = b['backend'] === 'r2' ? 'r2' : 'local'
      }
    } else rest[field] = value
  }
  return { prefs, rest }
}

/** Marks the copy of config.json's preferences that main writes as settings.json for the store to migrate. */
export const LEGACY_MARK = 'slidewell-config-prefs'

/**
 * The store's migrate hook. Main copies the preferences out of config.json into settings.json as
 * `{ [LEGACY_MARK]: 1, prefs: prefsFromLegacy(config) }` (never the key ciphertext); this reads them back.
 * Anything else that is not a settings file is not ours: null, so the store sets it aside as damaged.
 */
export function migrateLegacy(old: unknown): Migrated | null {
  if (!isRec(old) || old[LEGACY_MARK] !== 1 || !isRec(old['prefs'])) return null
  const settings: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(old['prefs'])) if (schema.def(k) && schema.def(k)?.type !== 'secret') settings[k] = v
  return { settings: settings as Migrated['settings'] }
}
