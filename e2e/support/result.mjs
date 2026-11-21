import { writeSync } from 'node:fs'

let reported = false
let failure

export function recordFailure(reason) {
  failure ??= reason
}

export function finish(reason, failureCode = 1) {
  if (reason) recordFailure(reason)
  reported = true
  process.exit(failure ? failureCode : 0)
}

export function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, value]) => value === false)
    .map(([name]) => name)
    .join(', ')
}

process.on('uncaughtException', (error) => {
  writeSync(2, String(error.stack ?? error) + '\n')
  finish(error.message || String(error))
})

process.on('exit', (code) => {
  const reason = failure ?? (code ? `exit ${code}` : reported ? null : 'spec ended without a result')
  if (reason && !code) process.exitCode = 1
  const line = reason ? `RESULT fail ${String(reason).replace(/\s+/g, ' ').trim()}` : 'RESULT pass'
  writeSync(1, line + '\n')
})
