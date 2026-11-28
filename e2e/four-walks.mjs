import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { preparePictureModel } from './support/prepare-picture-model.mjs'
import { finish } from './support/result.mjs'

const walks = [
  ['Match switch', 'match-switch', 5],
  ['More like this', 'more-like-this', 5],
  ['Picture search', 'picture-search', 20],
  ['Sorter', 'sorter', 15]
]
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('SLIDEWELL_') && name !== 'ELECTRON_RENDERER_URL' && name !== 'ELECTRON_RUN_AS_NODE'))

function run(command, args, { minutes, expectedResult = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', expectedResult ? 'pipe' : 'inherit', 'inherit'],
      timeout: minutes * 60_000
    })
    let result
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        console.log(line)
        if (line.startsWith('RESULT ')) result = line
      })
    }
    child.on('error', reject)
    child.on('close', (code, signal) => {
      const failure = signal ? `stopped by ${signal}` : `exit ${code}`
      if (code !== 0) reject(new Error(result?.startsWith('RESULT fail ') ? `${result} (${failure})` : failure))
      else if (expectedResult && result !== 'RESULT pass') reject(new Error(result ?? 'walk produced no result'))
      else resolve()
    })
  })
}

let model
try {
  const root = join(homedir(), 'Library', 'Caches', 'slidewell-four-walks')
  mkdirSync(root, { recursive: true })
  if (realpathSync(root) !== root) throw new Error(`Expected a direct cache path: ${root}`)
  const scratch = mkdtempSync(join(root, 'w-'))
  console.log(`Walk scratch: ${scratch}`)
  Object.assign(env, { TMPDIR: scratch, TEMP: scratch, TMP: scratch, SLIDEWELL_FOUR_WALKS_SCRATCH: scratch })
  await run('npm', ['run', 'build'], { minutes: 4 })
  model = await preparePictureModel(root)
} catch (error) {
  console.error(`Four walks setup failed: ${error.message}`)
  for (const [name] of walks) console.log(`FAIL ${name} — could not run: ${error.message}`)
  finish('four walks setup failed')
}

env.SLIDEWELL_PICTURE_MODEL_DIR = model
const failures = []
for (const [name, file, minutes] of walks) {
  console.log(`\nRunning ${name}`)
  try {
    await run(process.execPath, [`e2e/${file}.mjs`], { minutes, expectedResult: true })
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name} — ${error.message}`)
  }
}
finish(failures.length ? `walks failed: ${failures.join(', ')}` : null)
