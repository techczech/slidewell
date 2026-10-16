// Not on this Mac (Review): the header chip that shows only the screenshots whose picture is a cloud placeholder, and the
// bar of that view: Download them (one at a time, with progress and Cancel) and the switch that leaves them out of Review
// and sorting until they are downloaded. Main decides which ones they are, downloads them and stores the switch.
import { useEffect, useState } from 'react'
import type { ReviewDownloadProgress, ReviewSure } from '../../preload'

export function NotOnMacChip({ count, on, onChange }: { count: number; on: boolean; onChange: (on: boolean) => void }): JSX.Element | null {
  if (count <= 0 && !on) return null
  return (
    <button className={`rv-cloud-chip${on ? ' on' : ''}`} aria-pressed={on} data-testid="not-on-mac-chip" onClick={() => onChange(!on)}>
      Not on this Mac ({count})
    </button>
  )
}

export function NotOnMacBar({ sure, leaveOut, onChanged, onToast }: { sure: ReviewSure | null; leaveOut: boolean; onChanged: () => void; onToast: (m: string) => void }): JSX.Element {
  const [progress, setProgress] = useState<ReviewDownloadProgress | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    let live = true
    // one already running (started before he left Review and came back) shows its progress
    void window.sw.review.downloadStatus().then((p) => {
      if (live && p?.running) setProgress(p)
    })
    const off = window.sw.review.onDownloadProgress((p) => setProgress(p.running ? p : null))
    return () => {
      live = false
      off()
    }
  }, [])

  const start = async (): Promise<void> => {
    setResult(null)
    setStopping(false)
    setProgress({ running: true, total: 0, current: 0, done: 0, failed: 0 })
    try {
      const r = await window.sw.review.downloadNotOnMac(sure ?? undefined)
      setResult(r.message)
    } catch {
      setResult('The download did not start. Try again.')
    } finally {
      setProgress(null)
      setStopping(false)
      onChanged()
    }
  }
  const cancel = async (): Promise<void> => {
    setStopping(true)
    await window.sw.review.cancelDownload().catch(() => false)
  }
  const toggle = async (): Promise<void> => {
    try {
      await window.sw.review.setLeaveOutNotOnMac(!leaveOut)
    } catch {
      onToast('That setting did not change. Try again.')
    }
    onChanged()
  }

  const running = progress?.running === true
  return (
    <div className="rv-cloud-bar" data-testid="not-on-mac-bar">
      <p className="rv-cloud-note">These screenshots are in your cloud folder but their pictures are not downloaded to this Mac.</p>
      <div className="rv-cloud-row">
        {running ? (
          <>
            <span className="rv-cloud-progress" data-testid="download-progress" aria-live="polite">
              {stopping ? 'Stopping…' : progress.total ? `Downloading ${progress.current || 1} of ${progress.total}…` : 'Starting the download…'}
            </span>
            <button className="rv-cloud-cancel" onClick={() => void cancel()} disabled={stopping}>Cancel</button>
          </>
        ) : (
          <button className="rv-cloud-download" onClick={() => void start()}>Download them</button>
        )}
        {!running && result && <span className="rv-cloud-result" data-testid="download-result">{result}</span>}
      </div>
      <button className="rv-cloud-switch" role="switch" aria-checked={leaveOut} data-testid="leave-out-switch" onClick={() => void toggle()}>
        <span className="rv-tg" />
        Leave screenshots that are not on this Mac out of Review and sorting until they are downloaded
      </button>
    </div>
  )
}
