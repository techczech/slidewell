/**
 * Tiny wrapper around the system `sqlite3` binary — no native module (no electron-rebuild).
 * Reads are -json; writes execute a script. Params are inlined as hardened literals
 * (numbers verified finite; strings single-quote-escaped) so user input is data, never syntax.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export function sqlite3Bin(): string {
  return existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3'
}

function literal(v: string | number | null): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite param: ${v}`)
    return String(v)
  }
  return `'${v.replace(/'/g, "''")}'`
}

function inline(sql: string, params: Array<string | number | null>): string {
  let i = 0
  const out = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('more ? than params')
    return literal(params[i++])
  })
  if (i !== params.length) throw new Error(`placeholder/param mismatch (${i} vs ${params.length})`)
  return out
}

function exec(args: string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(sqlite3Bin(), args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || '').toString().trim() || err.message)) : resolve((stdout || '').toString())
    )
    child.stdin?.end(script)
  })
}

/** Read query → rows as objects. Opens the DB read-only. */
export async function query<T = Record<string, string>>(
  dbPath: string,
  sql: string,
  params: Array<string | number | null> = [],
  timeoutMs = 8000
): Promise<T[]> {
  const script = inline(sql, params)
  const out = await exec(['-json', '-readonly', `file:${dbPath}?mode=ro`], script.endsWith(';') ? script : `${script};`, timeoutMs)
  const t = out.trim()
  if (!t) return []
  try {
    return JSON.parse(t) as T[]
  } catch {
    throw new Error(`sqlite3 non-JSON: ${t.slice(0, 160)}`)
  }
}

/** Write/DDL → executes against a writable DB (created if absent). */
export async function run(dbPath: string, sql: string, params: Array<string | number | null> = [], timeoutMs = 8000): Promise<void> {
  const script = inline(sql, params)
  await exec([dbPath], script.endsWith(';') ? script : `${script};`, timeoutMs)
}

/** Sanitise a user string for FTS5 MATCH (wrap bare tokens in quotes unless it uses FTS syntax). */
export function safeFtsQuery(raw: string): string {
  const q = raw.trim()
  if (!q) return q
  const lowered = ` ${q.toLowerCase()} `
  const hasSyntax = q.includes('"') || q.includes('*') || ['and', 'or', 'not'].some((op) => lowered.includes(` ${op} `)) || /^near\(/i.test(q)
  if (hasSyntax) return q
  return q
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ')
}
