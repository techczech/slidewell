// Picture search: the Settings section (locked frame S2) and the status-bar segment (frame S3).
// The main process owns the model, the indexing and the store; this file only shows state and sends
// the user's choices (download, delete, pause/resume, well images on/off).
import { useCallback, useEffect, useState } from 'react'
import type { PictureSearchStatus } from '../../preload'

/** Live picture-search status: loaded once, then pushed by the main process. */
export function usePictureStatus(): PictureSearchStatus | null {
  const [st, setSt] = useState<PictureSearchStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.picture.status().then((s) => live && setSt(s))
    const off = window.sw.picture.onStatus((s) => setSt(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return st
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e6).toLocaleString('en-GB')} MB`

/** Status-bar words + Pause/Resume (frame S3). Shows nothing when picture search is off or idle. */
export function PictureSearchStatusBar(): JSX.Element | null {
  const st = usePictureStatus()
  if (!st) return null
  if (st.model === 'downloading' && st.download) {
    const pct = Math.floor((st.download.receivedBytes / Math.max(1, st.download.totalBytes)) * 100)
    return <span className="pic-status">· picture search: downloading model {pct}%</span>
  }
  const phase = st.index.phase
  if (st.model !== 'ready' || !st.text || phase === 'idle' || phase === 'done') return null
  return (
    <span className="pic-status">
      · {st.text} ·{' '}
      {phase === 'indexing' && (
        <button className="pic-btn" onClick={() => void window.sw.picture.pause()}>
          Pause
        </button>
      )}
      {phase === 'paused' && (
        <button className="pic-btn" onClick={() => void window.sw.picture.resume()}>
          Resume
        </button>
      )}
      {phase === 'error' && (
        <button className="pic-btn" onClick={() => void window.sw.picture.resume()}>
          Try again
        </button>
      )}
    </span>
  )
}

/** Settings › Picture search (frame S2): download / delete the model, well images, progress. */
export function PictureSearchSettings(): JSX.Element {
  const st = usePictureStatus()
  const [estimate, setEstimate] = useState<PictureSearchStatus['estimate']>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.sw.picture.estimate().then(setEstimate)
  }, [st?.includeWell])

  const download = useCallback(async () => {
    setBusy(true)
    try {
      await window.sw.picture.download()
    } finally {
      setBusy(false)
    }
  }, [])
  const remove = useCallback(async () => {
    setConfirmDelete(false)
    setBusy(true)
    try {
      await window.sw.picture.deleteModel()
    } finally {
      setBusy(false)
    }
  }, [])

  if (!st) return <div className="pic-settings" />
  const size = mb(st.modelBytes)
  const what = estimate
    ? `${estimate.slides.toLocaleString('en-GB')} slides${st.includeWell && estimate.wellImages ? ` and ${estimate.wellImages.toLocaleString('en-GB')} Well images` : ''}`
    : 'your slides'

  return (
    <div className="pic-settings" data-model={st.model}>
      <div className="pic-kicker">Settings</div>
      <h3 className="pic-title">Picture search</h3>
      <p>Find slides by what they look like, not only by the words on them.</p>
      <p>The model runs on this Mac. Your slides never leave it.</p>

      <div className="pic-actions">
        {(st.model === 'absent' || st.model === 'partial') && (
          <button className="pic-primary" disabled={busy} onClick={() => void download()}>
            {st.model === 'partial' && st.download ? `Resume download (${mb(st.download.receivedBytes)} of ${size} done)` : `Download model (${size})`}
          </button>
        )}
        {st.model === 'downloading' && st.download && (
          <>
            <progress className="pic-progress" value={st.download.receivedBytes} max={st.download.totalBytes} />
            <span className="pic-progress-text">
              Downloading {mb(st.download.receivedBytes)} of {size}
            </span>
            <button className="copyref" onClick={() => void window.sw.picture.cancelDownload()}>
              Cancel
            </button>
          </>
        )}
        {st.model === 'ready' && !confirmDelete && (
          <>
            <span className="pic-ready">✓ Model ready on this Mac ({size})</span>
            <button className="copyref" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete model
            </button>
          </>
        )}
        {st.model === 'ready' && confirmDelete && (
          <>
            <span className="pic-confirm">Delete the model? Search by meaning stops until you download it again.</span>
            <button className="copyref pic-danger" onClick={() => void remove()}>
              Delete
            </button>
            <button className="copyref" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        )}
      </div>
      {st.error && <p className="pic-error">Download stopped: {st.error}</p>}

      <div className="pic-note">
        {st.model === 'ready' && st.text
          ? `${st.text[0].toUpperCase()}${st.text.slice(1)}.${st.index.phase === 'indexing' ? ' Search by words keeps working meanwhile.' : ''}`
          : `Indexing ${what} takes ${estimate ? estimate.text : 'a while'} in the background; search by words keeps working meanwhile.`}
      </div>

      <label className="pic-check">
        <input type="checkbox" checked={st.includeWell} onChange={(e) => void window.sw.picture.setIncludeWell(e.target.checked)} />
        Also index images in the Well
      </label>
    </div>
  )
}
