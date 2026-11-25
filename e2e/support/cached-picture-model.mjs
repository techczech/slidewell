import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MODEL_DIR_NAME, MODEL_FILES, MODEL_REVISION } from '../../src/main/picture-search/model-manifest.ts'
import { finish } from './result.mjs'

export function requireCachedPictureModel(...variables) {
  const variable = variables.find((name) => process.env[name])
  if (!variable) finish(`Missing local picture model. Set ${variables.join(' or ')} to a verified ${MODEL_DIR_NAME} cache.`, 2)
  try {
    const source = realpathSync(process.env[variable])
    const marker = join(source, 'verified.json')
    if (!lstatSync(marker).isFile()) throw new Error('missing verification marker')
    const verified = JSON.parse(readFileSync(marker, 'utf8'))
    if (verified.revision !== MODEL_REVISION) throw new Error('wrong model revision')
    for (const { path, size, sha256 } of MODEL_FILES) {
      const file = join(source, path)
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size !== size || realpathSync(file) !== file ||
          !verified.files?.some((entry) => entry.path === path && entry.sha256 === sha256)) {
        throw new Error(`missing or unverified file ${path}`)
      }
    }
    return source
  } catch (error) {
    const detail = error.code ? error.code : error.message
    finish(`Invalid local picture model in ${variable}: ${detail}. Supply a verified ${MODEL_DIR_NAME} cache.`, 2)
  }
}

export function copyCachedPictureModel(source, userData) {
  const target = join(userData, 'models', MODEL_DIR_NAME)
  for (const path of [...MODEL_FILES.map((file) => file.path), 'verified.json']) {
    const destination = join(target, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, path), destination, constants.COPYFILE_FICLONE)
  }
}
