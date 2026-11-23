import { useEffect, useState } from 'react'
import type { CaptureFolderStatus } from '../../preload'
import { captureNotice } from './capture-notice'

export function useCaptureFolders(): CaptureFolderStatus[] | undefined {
  const [folders, setFolders] = useState<CaptureFolderStatus[]>()
  useEffect(() => {
    let receivedPush = false
    let mounted = true
    const off = window.sw.settings.onCaptureSourcesChanged((sources) => {
      receivedPush = true
      setFolders(sources)
    })
    void window.sw.settings.captureSourceStatus().then((sources) => {
      if (mounted && !receivedPush) setFolders(sources)
    })
    return () => { mounted = false; off() }
  }, [])
  return folders
}

export function CaptureFolderActions({ path }: { path: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(action: typeof window.sw.settings.replaceCaptureSource): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await action(path)
      if (!result.ok) setError(result.error)
    } catch {
      setError('SlideWell could not change this capture folder.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="copyref" disabled={busy} onClick={() => void run(window.sw.settings.replaceCaptureSource)}>Choose folder…</button>
      <button className="copyref" disabled={busy} onClick={() => void run(window.sw.settings.stopCaptureSource)}>Stop watching</button>
      {error && <span role="alert">{error}</span>}
    </>
  )
}

export function CaptureFolderNotice({ paths }: { paths: string[] }): JSX.Element | null {
  const message = captureNotice(paths)
  if (!message) return null
  return (
    <div className="triage-capture-notice triage-progress" role="status">
      <span>{message}</span>
      {paths.length === 1
        ? <CaptureFolderActions key={paths[0]} path={paths[0]} />
        : <button className="copyref" onClick={() => void window.sw.app.openSettings('capture-sources')}>Open Settings</button>}
    </div>
  )
}
