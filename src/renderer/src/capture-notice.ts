export function captureNotice(paths: readonly string[]): string | null {
  if (!paths.length) return null
  if (paths.length > 1) return `SlideWell can no longer find ${paths.length} capture folders. New screenshots from them are not arriving.`
  const path = paths[0]
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  return `SlideWell can no longer find the capture folder ${name} at ${path}. New screenshots from it are not arriving.`
}
