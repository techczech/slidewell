import { useEffect, useRef, useState } from 'react'

export function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const [archive, setArchive] = useState('')
  const [othersRoot, setOthersRoot] = useState('')
  const [destLib, setDestLib] = useState<'mine' | 'others'>('mine')
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.sw.ingest.onLine((l) => setLines((prev) => [...prev, l])), [])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => {
      setArchive(p.archiveRoot ?? p.archiveDefault)
      setOthersRoot(p.othersArchiveRoot)
    })
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])
  async function choose(): Promise<void> {
    const p = await window.sw.ingest.choosePath()
    if (p) setTarget(p)
  }
  async function run(fn: () => Promise<{ ok: boolean }>): Promise<void> {
    setRunning(true)
    const r = await fn()
    setRunning(false)
    if (r.ok) onDone()
  }
  return (
    <div className="overlay" onClick={running ? undefined : onClose}>
      <div className="modal import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Import PowerPoint</b>
          <button className="copyref" onClick={onClose} disabled={running}>close ✕</button>
        </div>
        <p className="settings-note">
          Extracts + OCRs slides into a searchable library. Choose <b>your archive</b> (your own presentations) or your separate{' '}
          <b>Others’ Library</b> (other people’s slides, kept out of your archive).
        </p>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">Add to which library</div>
              <div className="settings-row-detail"><i>{destLib === 'mine' ? 'Catalogued as part of your own library.' : 'A separate store — other people’s slides never mix into your archive.'}</i></div>
            </div>
            <div className="scope" role="tablist" aria-label="Destination library">
              <button role="tab" aria-selected={destLib === 'mine'} className={destLib === 'mine' ? 'scope-tab active' : 'scope-tab'} onClick={() => setDestLib('mine')}>My archive</button>
              <button role="tab" aria-selected={destLib === 'others'} className={destLib === 'others' ? 'scope-tab active' : 'scope-tab'} onClick={() => setDestLib('others')}>Others’ library</button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">What to import</div>
              <div className="settings-row-detail" title={target ?? ''}>{target ?? '— no file or folder chosen —'}</div>
            </div>
            <button className="copyref" disabled={running} onClick={() => void choose()}>Choose file / folder…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">Where it goes</div>
              <div className="settings-row-detail" title={destLib === 'mine' ? archive : othersRoot}>{(destLib === 'mine' ? archive : othersRoot) || '— not set —'}</div>
              <div className="settings-row-detail"><i>{destLib === 'mine' ? 'Your archive (change it in ⚙ Settings).' : 'Your Others’ Library (change it in ⚙ Settings).'}</i></div>
            </div>
          </div>
        </div>
        <div className="import-actions">
          <button className="primary-btn" disabled={running || !target} onClick={() => target && void run(() => window.sw.ingest.runPath(target, destLib))}>
            {destLib === 'mine' ? 'Import to my archive' : 'Import to Others’ library'}
          </button>
          {destLib === 'mine' && (
            <button className="copyref" disabled={running} title="Crawl + extract every not-yet-imported presentation already in the archive" onClick={() => void run(() => window.sw.ingest.pending())}>
              …or ingest everything pending
            </button>
          )}
          {running && (
            <button className="copyref" onClick={() => void window.sw.ingest.cancel()}>Cancel</button>
          )}
        </div>
        <pre className="import-log" ref={logRef}>
          {lines.join('\n') || 'Pick the destination library, choose a file/folder, then Import. Extraction + OCR run via Core A; progress streams here. Re-running is safe — done presentations are skipped.'}
        </pre>
        {running && <div className="results-head">running in the background — you can keep searching</div>}
      </div>
    </div>
  )
}

// Convert (sideband, throwaway): turn SOMEONE ELSE'S .pptx into a mechanical Outline folder the
// user picks. Source + destination + options are all chosen IN the panel before the final Convert.
