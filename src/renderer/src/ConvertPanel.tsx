import { useEffect, useRef, useState } from 'react'

const fileName = (p: string): string => p.split('/').pop() || p

export function ConvertPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [ocr, setOcr] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [dest, setDest] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.sw.convert.onLine((l) => setLines((prev) => [...prev, l])), [])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => setOcr(p.convertOcrDefault))
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])
  async function chooseSource(): Promise<void> {
    const p = await window.sw.convert.chooseSource()
    if (p) {
      setSource(p)
      setDone(null)
    }
  }
  async function chooseDest(): Promise<void> {
    if (!source) return
    const p = await window.sw.convert.chooseDest(source)
    if (p) setDest(p)
  }
  async function run(): Promise<void> {
    if (!source || !dest) return
    setRunning(true)
    setDone(null)
    setLines([])
    const r = await window.sw.convert.run({ pptxPath: source, outDir: dest, ocr })
    setRunning(false)
    if (r.ok && r.outDir) setDone(r.outDir)
  }
  const toggleOcr = (v: boolean): void => {
    setOcr(v)
    void window.sw.settings.setConvertOcr(v)
  }
  return (
    <div className="overlay" onClick={running ? undefined : onClose}>
      <div className="modal import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Convert someone else’s PowerPoint to an Outline</b>
          <button className="copyref" onClick={onClose} disabled={running}>close ✕</button>
        </div>
        <p className="settings-note">
          Makes an editable TalkWeaver Outline saved wherever you choose. <b>Never</b> added to your archive or vault, and stamped <code>origin: external</code> so it stays clearly not-yours.
        </p>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">1 · PowerPoint to convert</div>
              <div className="settings-row-detail" title={source ?? ''}>{source ? fileName(source) : '— no file chosen —'}</div>
            </div>
            <button className="copyref" disabled={running} onClick={() => void chooseSource()}>Choose .pptx…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">2 · Save the Outline to</div>
              <div className="settings-row-detail" title={dest ?? ''}>{dest ?? (source ? '— choose a destination folder —' : '— pick a PowerPoint first —')}</div>
            </div>
            <button className="copyref" disabled={running || !source} onClick={() => void chooseDest()}>Choose folder…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">3 · OCR image text</div>
              <div className="settings-row-detail">Recognise text inside images (macOS Vision) and inline it into the Outline.</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={ocr} onChange={(e) => toggleOcr(e.target.checked)} /> {ocr ? 'On' : 'Off'}
            </label>
          </div>
        </div>
        <div className="import-actions">
          <button className="primary-btn" disabled={running || !source || !dest} onClick={() => void run()}>
            Convert →
          </button>
        </div>
        <pre className="import-log" ref={logRef}>
          {lines.join('\n') ||
            'Pick a PowerPoint and a destination folder, then Convert. SlideWell extracts it in a scratch space and writes a mechanical Outline (outline + assets) where you chose. Nothing is added to your library.'}
        </pre>
        {done && <div className="results-head">✓ Saved to {done} — revealed in Finder.</div>}
        {running && <div className="results-head">converting…</div>}
      </div>
    </div>
  )
}
