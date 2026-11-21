// Saving the R2 connection from the old R2 card (settings:set-r2). Its endpoint, bucket and account live in the
// settings file and its key ciphertext in config.json, so one change is two writes to two files. They land
// together or not at all: the key is encrypted first (nothing written yet), the preferences are written and
// awaited, then the ciphertext; if the ciphertext cannot be written the preferences are put back. The answer
// is ok only when both landed. Saves run one at a time in this process, and a put-back restores only a value
// this save wrote that is still there, so it never undoes another writer's change. If the put-back itself
// fails, the answer says the R2 settings were not saved completely (PARTIAL_R2_SAVE).
// No Electron here: main passes the writes in, the tests pass fakes.

export type R2Patch = { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string }
export type R2Prefs = { accountId?: string; endpoint?: string; bucket?: string; prefix?: string }
export type R2Ciphertext = { accessKeyIdEnc: string; secretEnc: string }
export type Saved = { ok: true } | { ok: false; error: string }
export type R2SaveAnswer = { ok: boolean; gotKeys: boolean; encAvailable: boolean; savedCreds: boolean; error?: string }

export type R2SaveDeps = {
  encAvailable(): boolean
  /** safeStorage encryption, base64; may throw. */
  encrypt(plain: string): string
  /** Writes the preferences named in `prefs` and resolves once all reached the file. */
  writePrefs(prefs: R2Prefs): Promise<Saved>
  /** What `writePrefs` would need to put the named preferences back as they are now. */
  snapshot(fields: ReadonlyArray<keyof R2Prefs>): R2Prefs
  /** Writes the ciphertext; throws when it did not land. */
  writeCiphertext(enc: R2Ciphertext): void
}

const FIELDS = ['accountId', 'endpoint', 'bucket', 'prefix'] as const
/** Shown when a save failed and its put-back failed too, so the R2 settings may be half old, half new. */
export const PARTIAL_R2_SAVE = 'The R2 settings could not be saved completely — check them.'
const sameValue = (a: unknown, b: unknown): boolean => (a ?? '') === (b ?? '')
const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'error'

let queue: Promise<unknown> = Promise.resolve()

/** One save at a time per process: a second save starts only after the first has finished, put-back included. */
export function saveR2(patch: unknown, deps: R2SaveDeps): Promise<R2SaveAnswer> {
  const run = queue.then(() => saveR2Now(patch, deps))
  queue = run.catch(() => undefined)
  return run
}

async function saveR2Now(patch: unknown, deps: R2SaveDeps): Promise<R2SaveAnswer> {
  const p = (patch && typeof patch === 'object' ? patch : {}) as R2Patch
  const prefs: R2Prefs = {}
  for (const f of FIELDS) if (typeof p[f] === 'string') prefs[f] = (p[f] as string).trim()
  // Keys are write-only: only replaced when both are given.
  const gotKeys = typeof p.accessKeyId === 'string' && p.accessKeyId !== '' && typeof p.secretAccessKey === 'string' && p.secretAccessKey !== ''
  const encAvailable = deps.encAvailable()
  const fail = (error: string): R2SaveAnswer => ({ ok: false, gotKeys, encAvailable, savedCreds: false, error })

  let enc: R2Ciphertext | null = null
  if (gotKeys) {
    if (!encAvailable) return fail('OS keychain (safeStorage) unavailable')
    try {
      enc = { accessKeyIdEnc: deps.encrypt(p.accessKeyId as string), secretEnc: deps.encrypt(p.secretAccessKey as string) }
    } catch (e) {
      return fail((e as Error)?.message || 'The keys could not be encrypted.')
    }
  }

  const fields = FIELDS.filter((f) => f in prefs)
  const before = deps.snapshot(fields)
  // Puts back only what this save changed and is still its value now; anything else is left as it is.
  // Accepted residual: the compare (snapshot) and the write below are not under one settings lock, so a generic
  // Settings or CLI write of the same R2 field landing between them is overwritten by the put-back. Same user on
  // the same Mac, and only after a ciphertext failure (review round 3, #6).
  const putBack = async (): Promise<boolean> => {
    const now = deps.snapshot(fields)
    const back: R2Prefs = {}
    for (const f of fields) if (!sameValue(before[f], prefs[f]) && sameValue(now[f], prefs[f])) back[f] = before[f]
    if (Object.keys(back).length === 0) return true
    try {
      return (await deps.writePrefs(back)).ok
    } catch {
      return false
    }
  }
  if (fields.length > 0) {
    const wrote = await deps.writePrefs(prefs)
    if (!wrote.ok) return fail((await putBack()) ? wrote.error : PARTIAL_R2_SAVE)
  }
  if (enc) {
    try {
      deps.writeCiphertext(enc)
    } catch (e) {
      if (!(await putBack())) return fail(PARTIAL_R2_SAVE)
      return fail(`The R2 keys were not saved (${code(e)}); your earlier R2 settings were kept.`)
    }
  }
  return { ok: true, gotKeys, encAvailable, savedCreds: Boolean(enc) }
}
