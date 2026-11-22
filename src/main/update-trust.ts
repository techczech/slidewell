import { execFile, execFileSync } from 'node:child_process'
import { UPDATE_INSTALL_IDENTITY } from '../shared/update-identity'

type TrustIdentity = { bundleId: string; team: string | null }

export const RELEASE_TRUST: TrustIdentity = {
  bundleId: UPDATE_INSTALL_IDENTITY.bundleId,
  team: 'M7H45AGG8A'
}

/** Selected only by the build-time fixture flag. The fixture has its own bundle identity. */
export const FIXTURE_TRUST: TrustIdentity = {
  bundleId: UPDATE_INSTALL_IDENTITY.fixtureBundleId,
  team: null
}

function signatureArgs(bundle: string, { bundleId, team }: TrustIdentity): string[] {
  const identifier = `identifier "${bundleId}"`
  const requirement = team
    ? `${identifier} and anchor apple generic and certificate leaf[subject.OU] = "${team}"`
    : identifier
  return ['--verify', '--deep', '--strict', '-R', `=${requirement}`, bundle]
}

export function runningSignatureMatches(bundle: string, identity: TrustIdentity): boolean {
  try {
    execFileSync('/usr/bin/codesign', signatureArgs(bundle, identity), { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

type Execute = (tool: string, args: string[]) => Promise<string>
const execute: Execute = (tool, args) => new Promise((resolve, reject) => {
  execFile(tool, args, {
    timeout: 60_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' }
  }, (error, stdout, stderr) => error ? reject(error) : resolve(stdout + stderr))
})

/** Both checks must succeed before macOS's native updater can see the ZIP. */
export async function verifyBundleTrust(bundle: string, identity: TrustIdentity, run = execute): Promise<'signature' | 'notarisation' | null> {
  try {
    await run('/usr/bin/codesign', signatureArgs(bundle, identity))
  } catch {
    return 'signature'
  }
  if (identity.team === null) return null
  try {
    const assessment = await run('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', bundle])
    // Local Gatekeeper overrides may accept a bundle without a notarisation decision.
    return /^source=Notarized Developer ID\s*$/m.test(assessment) ? null : 'notarisation'
  } catch {
    return 'notarisation'
  }
}
