// Settings › Screenshot sorter › cloud step (tickets 07, 16): which company is asked (OpenAI's Luna
// or Anthropic's Haiku), a key for each (write-only: saved or not), asking on or off (off until he
// turns it on; main records when, per provider), the nightly batch time, and "Sort now", which runs
// the sorter on this Mac, then shows how many screenshots would go to the chosen model, what is sent
// with each and an estimated cost, and sends only that batch on a click (main checks the batch's
// one-time token and that the provider and the period are still the ones it was prepared for). Sort
// now is limited to the period chosen beside it (SortPeriodSelect; the same setting as the local
// sorter's button); main states the period and the count for it. The main process owns
// all of it (src/main/sorter/cloud/): no key ever comes back here, choosing a provider while asking
// is on raises main's own dialog, and the per-night limit is fixed there.
import { useCallback, useEffect, useState } from 'react'
import type { CloudPreview, CloudProviderId, CloudStatus } from '../../preload'
import { SortPeriodSelect } from './SortPeriodSelect'

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
  const [typed, setTyped] = useState<Record<CloudProviderId, string>>({ openai: '', anthropic: '' })
  const [keyMsg, setKeyMsg] = useState<{ provider: CloudProviderId; text: string } | null>(null)
  const [preview, setPreview] = useState<CloudPreview | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const saveKey = useCallback(
    async (provider: CloudProviderId) => {
      const r = await window.sw.cloud.setKey(provider, typed[provider])
      setTyped((t) => ({ ...t, [provider]: '' })) // the field never keeps the key
      setKeyMsg({ provider, text: r.ok ? 'Key saved, encrypted in the macOS keychain.' : (r.error ?? 'The key was not saved.') })
      setSt(r.status)
    },
    [typed, setSt]
  )
  const removeKey = useCallback(
    async (provider: CloudProviderId) => {
      setSt(await window.sw.cloud.clearKey(provider))
      setKeyMsg({ provider, text: 'Key removed.' })
    },
    [setSt]
  )
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
  const { name, company } = st
  // the batch in the confirm box names the provider it was prepared for
  const prepared = preview ? (st.providers.find((p) => p.id === preview.provider) ?? null) : null

  return (
    <div className="pic-settings sorter-cloud" data-phase={st.phase} data-provider={st.settings.provider}>
      <h3 className="pic-title">Ask {name} about the doubtful ones</h3>
      <p>
        When the sorter on this Mac is unsure about a screenshot, it can ask OpenAI’s Luna or Anthropic’s Haiku. This is off until you turn it on. Only screenshots the
        sorter could not call are sent. For each one, {company} receives the picture, shrunk to {n(st.longEdge)} pixels, and the app name and window title from its file
        name. Window titles can name documents, people or folders.
      </p>
      <p>
        {name}’s throwaway counts only when it is as sure as the sorter must be; if {name} is unsure, the screenshot waits for you in Review.
      </p>

      <div className="settings-row sorter-cloud-provider" role="radiogroup" aria-label="Which model to ask">
        <span className="settings-row-label">Ask</span>
        {st.providers.map((p) => (
          <label key={p.id}>
            <input
              type="radio"
              name="sorter-cloud-provider"
              className={`sorter-cloud-provider-${p.id}`}
              checked={st.settings.provider === p.id}
              disabled={busy}
              onChange={() => void set({ provider: p.id })}
            />
            {p.company} {p.name}
          </label>
        ))}
      </div>
      <div className="pic-note">
        Each has its own key and its own agreement: turning on one sends nothing to the other, and choosing the other while asking is on asks you again. When one
        was unsure about a screenshot, the other can be asked about it once; a screenshot both have answered is not sent again.
        {st.settings.provider === 'anthropic' ? ' Haiku calls draw on the free monthly Anthropic API credits where they are available.' : ''}
      </div>

      {st.providers.map((p) => (
        <div key={p.id} className={`settings-row sorter-cloud-key sorter-cloud-key-${p.id}`}>
          <span className="settings-row-label">{p.company} key</span>
          {p.hasKey ? (
            <>
              <span className="pic-ready">Saved, encrypted on this Mac</span>
              <button className="copyref" onClick={() => void removeKey(p.id)}>
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
                placeholder={`Paste your ${p.company} API key`}
                value={typed[p.id]}
                onChange={(e) => setTyped((t) => ({ ...t, [p.id]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && typed[p.id] && void saveKey(p.id)}
              />
              <button className="copyref" disabled={!typed[p.id].trim() || !st.encryptionAvailable} onClick={() => void saveKey(p.id)}>
                Save key
              </button>
            </>
          )}
        </div>
      ))}
      {!st.encryptionAvailable && <div className="pic-error">The macOS keychain is not available, so a key cannot be stored.</div>}
      {keyMsg && (
        <div className="pic-note sorter-cloud-key-msg">
          {st.providers.find((p) => p.id === keyMsg.provider)?.company} key: {keyMsg.text}
        </div>
      )}

      <label className="pic-check">
        <input type="checkbox" className="sorter-cloud-enabled" checked={st.settings.enabled} onChange={(e) => void set({ enabled: e.target.checked })} />
        <span>
          Ask {name} every night at{' '}
          <input type="time" className="sorter-cloud-time" value={st.settings.batchTime} onChange={(e) => e.target.value && void set({ batchTime: e.target.value })} /> and
          when I press Sort now
        </span>
      </label>
      <div className="pic-note">
        At most {n(st.nightlyLimit)} screenshots a night are sent, nightly and Sort now together, whichever of the two is asked. The nightly sort runs only while SlideWell
        is open; if the time passes while it is closed, it runs at the next launch.
        {st.settings.enabled && st.nextRunAt ? ` Next: ${when(st.nextRunAt)}.` : ''}
        {st.hasKey ? '' : ` Without an ${company} key, it sorts on this Mac only.`}
      </div>

      <div className="pic-actions">
        {!asking && (
          <button className="pic-primary sorter-cloud-sort" disabled={busy} onClick={() => void sortNow()}>
            {preparing ? 'Sorting on this Mac…' : 'Sort now'}
          </button>
        )}
        {!asking && <SortPeriodSelect period={st.period} periods={st.periods} disabled={busy} />}
        {asking && (
          <>
            <progress className="pic-progress" value={st.done} max={Math.max(1, st.total)} />
            <span className="pic-progress-text">
              Asking {name} · {n(st.done)} of {n(st.total)}
            </span>
            <button className="copyref" onClick={() => void window.sw.cloud.cancel()}>
              Stop
            </button>
          </>
        )}
      </div>
      <div className="sorter-period-hint">
        Sort now sorts, and asks {name} about, only the screenshots taken in the chosen period. The nightly sort takes everything, within the nightly limit.
      </div>
      {result && <div className="pic-note sorter-cloud-result">{result}</div>}
      {st.lastRun && !result && (
        <div className="pic-note sorter-cloud-last">
          {st.lastRun.trigger === 'nightly' ? 'Last night’s sort' : 'Last Sort now'} ({when(st.lastRun.at)}): {st.lastRun.message}
        </div>
      )}

      {preview && prepared && (
        <div
          className="overlay sorter-cloud-overlay"
          onClick={(e) => {
            e.stopPropagation() // the Settings overlay behind must not close
            setPreview(null)
          }}
        >
          <div className="sorter-cloud-confirm" role="dialog" aria-label={`Send to ${prepared.name}`} onClick={(e) => e.stopPropagation()}>
            <h3>{preview.message}</h3>
            {preview.local.message && <p>{preview.local.message}</p>}
            <p>
              {n(preview.toSend)} screenshot{preview.toSend === 1 ? '' : 's'} the sorter could not call
              {preview.secondNote ? <span className="sorter-cloud-second">, {preview.secondNote},</span> : null} will be sent to {prepared.company} ({prepared.model}) in{' '}
              {n(preview.estimate.requests)} request
              {preview.estimate.requests === 1 ? '' : 's'}. {preview.costLabel}: <b>{usd(preview.estimate.usd)}</b>.{preview.costNote ? ` ${preview.costNote}` : ''}
            </p>
            <p className="sorter-cloud-period-note">{preview.periodNote}</p>
            <p className="sorter-cloud-what">
              With each picture, shrunk to {n(st.longEdge)} pixels, {prepared.company} receives the app name and window title from the file name. Window titles can name
              documents, people or folders. The file’s folder and the text read from the picture are not sent.
            </p>
            <p>If {prepared.name} is unsure, they stay in Review.</p>
            <div className="sorter-cloud-confirm-btns">
              <button className="copyref" onClick={() => setPreview(null)}>
                Not now
              </button>
              <button className="pic-primary sorter-cloud-send" autoFocus onClick={() => void send()}>
                Send {n(preview.toSend)} to {prepared.name}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
