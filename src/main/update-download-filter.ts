// The isolated download partition can reach only the release host and GitHub's HTTPS asset host.
export function updateRequestAllowed(address: string, fixtureOrigin: string | null = null): boolean {
  let url: URL
  try { url = new URL(address) } catch { return false }
  if (url.username || url.password || url.hash) return false
  if (fixtureOrigin) return url.origin === fixtureOrigin
  if (url.protocol !== 'https:' || url.port) return false
  return url.hostname === 'github.com' || url.hostname === 'release-assets.githubusercontent.com' ||
    url.hostname === 'objects.githubusercontent.com'
}

export function installUpdateDownloadFilter(session: Electron.Session, fixtureOrigin: string | null): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !updateRequestAllowed(details.url, fixtureOrigin) })
  })
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: { 'User-Agent': 'SlideWell', Accept: '*/*', 'Cache-Control': 'no-cache' } })
  })
}
