// Settings › Screenshot sorter › Ask Luna (ticket 07): the OpenAI key (write-only: saved or not),
// asking Luna on or off (off until he turns it on; main records when), the nightly batch time, and
// "Sort now", which runs the sorter on this Mac, then shows how many screenshots would go to Luna,
// what is sent with each and an estimated cost, and sends only that batch on a click (main checks
// the batch's one-time token). The main process owns all of it (src/main/sorter/cloud/); the key
// never comes back here, and the per-night limit is fixed there.
import { useCallback, useEffect, useState } from 'react'
import type { CloudPreview, CloudStatus } from '../../preload'

const n = (x: number): string => x.toLocaleString('en-GB')
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const usd = (x: number): string => (x < 0.01 ? 'under $0.01' : `about $${x.toFixed(2)}`)

function useCloudStatus(): [CloudStatus | null, (s: CloudStatus) => void] {
  const [st, setSt] = useState<CloudStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.cloud.status().then((s) => live && setSt(s))
    const off = window.sw.cloud.onStatus((s) => setSt(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return [st, setSt]
}

export function SorterCloudSettings(): JSX.Element {
  const [st, setSt] = useCloudStatus()
  const [key, setKey] = useState('')
  const [keyMsg, setKeyMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<CloudPreview | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const saveKey = useCallback(async () => {
    const r = await window.sw.cloud.setKey(key)
    setKey('') // the field never keeps the key
    setKeyMsg(r.ok ? 'Key saved, encrypted in the macOS keychain.' : (r.error ?? 'The key was not saved.'))
    setSt(r.status)
  }, [key, setSt])
  const removeKey = useCallback(async () => {
    setSt(await window.sw.cloud.clearKey())
    setKeyMsg('Key removed.')
  }, [setSt])
  const set = useCallback(async (patch: Partial<CloudStatus['settings']>) => setSt(await window.sw.cloud.setSettings(patch)), [setSt])

  const sortNow = useCallback(async () => {
    setResult(null)
    setPreparing(true)
    try {
      const p = await window.sw.cloud.prepare()
      if (p.blocked) setResult([p.local.message, p.message].filter(Boolean).join(' '))
      else setPreview(p)
    } finally {
      setPreparing(false)
    }
  }, [])
  const send = useCallback(async () => {
    if (!preview?.token) return
    const token = preview.token
    setPreview(null)
    const r = await window.sw.cloud.send(token)
    setResult(r.message)
  }, [preview])

  if (!st) return <div className="pic-settings sorter-cloud" />
  const asking = st.phase === 'asking'
  const busy = st.phase !== 'idle' || preparing

  return (
    <div className="pic-settings sorter-cloud" data-phase={st.phase}>
      <h3 className="pic-title">Ask Luna about the doubtful ones</h3>
      <p>
        When the sorter on this Mac is unsure about a screenshot, it can ask OpenAI’s Luna. This is off until you turn it on. Only screenshots the sorter could not call are
        sent. For each one, OpenAI receives the picture, shrunk to {n(st.longEdge)} pixels, and the app name and window title from its file name. Window titles can name
        documents, people or folders.
      </p>
      <p>Luna’s throwaway counts only when it is as sure as the sorter must be; if Luna is unsure, the screenshot waits for you in Review.</p>

      <div className="settings-row sorter-cloud-key">
        <span className="settings-row-label">OpenAI key</span>
        {st.hasKey ? (
          <>
            <span className="pic-ready">Saved, encrypted on this Mac</span>
            <button className="copyref" onClick={() => void removeKey()}>
              Remove key
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              className="sorter-cloud-key-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your OpenAI API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key && void saveKey()}
            />
            <button className="copyref" disabled={!key.trim() || !st.encryptionAvailable} onClick={() => void saveKey()}>
              Save key
            </button>
          </>
        )}
      </div>
      {!st.encryptionAvailable && <div className="pic-error">The macOS keychain is not available, so a key cannot be stored.</div>}
      {keyMsg && <div className="pic-note sorter-cloud-key-msg">{keyMsg}</div>}

      <label className="pic-check">
        <input type="checkbox" className="sorter-cloud-enabled" checked={st.settings.enabled} onChange={(e) => void set({ enabled: e.target.checked })} />
        <span>
          Ask Luna every night at{' '}
          <input type="time" className="sorter-cloud-time" value={st.settings.batchTime} onChange={(e) => e.target.value && void set({ batchTime: e.target.value })} /> and
          when I press Sort now
        </span>
      </label>
      <div className="pic-note">
        At most {n(st.nightlyLimit)} screenshots a night go to Luna, nightly and Sort now together. The nightly sort runs only while SlideWell is open; if the time
        passes while it is closed, it runs at the next launch.
        {st.settings.enabled && st.nextRunAt ? ` Next: ${when(st.nextRunAt)}.` : ''}
        {st.hasKey ? '' : ' Without a key, it sorts on this Mac only.'}
      </div>

      <div className="pic-actions">
        {!asking && (
          <button className="pic-primary sorter-cloud-sort" disabled={busy} onClick={() => void sortNow()}>
            {preparing ? 'Sorting on this Mac…' : 'Sort now'}
          </button>
        )}
        {asking && (
          <>
            <progress className="pic-progress" value={st.done} max={Math.max(1, st.total)} />
            <span className="pic-progress-text">
              Asking Luna · {n(st.done)} of {n(st.total)}
            </span>
            <button className="copyref" onClick={() => void window.sw.cloud.cancel()}>
              Stop
            </button>
          </>
        )}
      </div>
      {result && <div className="pic-note sorter-cloud-result">{result}</div>}
      {st.lastRun && !result && (
        <div className="pic-note sorter-cloud-last">
          {st.lastRun.trigger === 'nightly' ? 'Last night’s sort' : 'Last Sort now'} ({when(st.lastRun.at)}): {st.lastRun.message}
        </div>
      )}

      {preview && (
        <div
          className="overlay sorter-cloud-overlay"
          onClick={(e) => {
            e.stopPropagation() // the Settings overlay behind must not close
            setPreview(null)
          }}
        >
          <div className="sorter-cloud-confirm" role="dialog" aria-label="Send to Luna" onClick={(e) => e.stopPropagation()}>
            <h3>{preview.message}</h3>
            {preview.local.message && <p>{preview.local.message}</p>}
            <p>
              {n(preview.toSend)} screenshot{preview.toSend === 1 ? '' : 's'} the sorter could not call will be sent to OpenAI ({st.model}) in {n(preview.estimate.requests)} request
              {preview.estimate.requests === 1 ? '' : 's'}. Estimated cost: <b>{usd(preview.estimate.usd)}</b>.
            </p>
            <p className="sorter-cloud-what">
              With each picture, shrunk to {n(st.longEdge)} pixels, OpenAI receives the app name and window title from the file name. Window titles can name documents,
              people or folders. The file’s folder and the text read from the picture are not sent.
            </p>
            <p>If Luna is unsure, they stay in Review.</p>
            <div className="sorter-cloud-confirm-btns">
              <button className="copyref" onClick={() => setPreview(null)}>
                Not now
              </button>
              <button className="pic-primary sorter-cloud-send" autoFocus onClick={() => void send()}>
                Send {n(preview.toSend)} to Luna
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
