// Settings › Screenshot sorter (locked mockup 2026-10-12, frame S4): which service helps with the unsure
// ones (Off, Luna from OpenAI or Haiku from Anthropic), a key for each, when he agreed to each, second
// opinions, and a pointer to Triage › Auto sorting, where training, sorting and the nightly run live.
// The main process owns all of it (src/main/sorter/cloud/): no key ever comes back here, and choosing a
// service he has not agreed to raises main's own dialog; declined, the choice stays as it was.
import { useCallback, useState } from 'react'
import type { CloudProviderId } from '../../preload'
import { useCloudStatus } from './sorter-hooks'
import { day, n } from './sorter-format'

// Keys are added, replaced and removed in Settings › Accounts and keys (main/key-slots.ts, the same save and
// remove as before); this page shows whether each is saved and opens that section.
export function SorterServiceSettings({ onOpenAutoSorting, onOpenKeys }: { onOpenAutoSorting: () => void; onOpenKeys: () => void }): JSX.Element {
  const [st, setSt] = useCloudStatus()
  const [secondError, setSecondError] = useState<string | null>(null)

  // Off keeps the last provider, both keys and both agreements; a provider turns the service on for it
  const choose = useCallback(async (value: 'off' | CloudProviderId) => setSt(await window.sw.cloud.setSettings(value === 'off' ? { enabled: false } : { provider: value, enabled: true })), [setSt])
  const setSecond = useCallback(
    async (on: boolean) => {
      const r = await window.sw.cloud.setSecondOpinions(on)
      setSt(r.status)
      setSecondError(r.ok ? null : (r.error ?? 'Second opinions were not changed.'))
    },
    [setSt]
  )

  if (!st) return <div className="pic-settings sorter-cloud" />
  const busy = st.phase !== 'idle'
  const on = st.settings.enabled
  const value: 'off' | CloudProviderId = on ? st.settings.provider : 'off'
  const [first, second] = st.providers
  const options: Array<{ id: 'off' | CloudProviderId; label: string }> = [{ id: 'off', label: 'Off' }, ...st.providers.map((p) => ({ id: p.id, label: `${p.name} from ${p.company}` }))]
  const selected = st.providers.find((p) => p.id === st.settings.provider) ?? first

  return (
    <div className="pic-settings sorter-cloud sorter-settings" data-phase={st.phase} data-provider={st.settings.provider}>
      <h3 className="pic-title">Screenshot sorter</h3>
      <p>
        The sorter runs on this Mac. When it is unsure about a screenshot, it can ask {first.name} from {first.company} or {second.name} from {second.company}. This is off until you choose one.
      </p>

      <div className="sr">
        <div className="sr-lab">Which service helps with the unsure ones</div>
        <div>
          <div className="seg3 sorter-cloud-provider" role="radiogroup" aria-label="Which service helps with the unsure ones">
            {options.map((o) => (
              <label key={o.id} className={value === o.id ? 'on' : ''}>
                <input type="radio" name="sorter-cloud-provider" className={`sorter-cloud-provider-${o.id}`} checked={value === o.id} disabled={busy} onChange={() => void choose(o.id)} />
                {o.label}
              </label>
            ))}
          </div>
          <div className="sr-help">Only screenshots the sorter could not call are sent. Each service has its own key and its own agreement; choosing the other one asks you again.</div>
        </div>
      </div>

      {st.providers.map((p) => (
        <div key={p.id} className={`sr sorter-cloud-key sorter-cloud-key-${p.id}`}>
          <div className="sr-lab">{p.company} key</div>
          <div>
            <div className="sr-row">
              <span className={p.hasKey ? 'pic-ready' : 'sr-help sr-none'}>{p.hasKey ? 'Saved, encrypted on this Mac' : 'No key yet'}</span>
              <button className="copyref sorter-open-keys" onClick={onOpenKeys}>
                {p.hasKey ? 'Replace or remove…' : 'Add key…'}
              </button>
            </div>
            {p.id === 'anthropic' && <div className="sr-help">Haiku calls draw on the free monthly Anthropic API credits where they are available.</div>}
          </div>
        </div>
      ))}
      {!st.encryptionAvailable && <div className="pic-error">The macOS keychain is not available, so a key cannot be stored.</div>}
      {on && !st.hasKey && <div className="sr-help sr-after">Without an {selected.company} key, it sorts on this Mac only.</div>}

      {st.providers.map((p) => (
        <div key={p.id} className={`sr sorter-cloud-agreement sorter-cloud-agreement-${p.id}`}>
          <div className="sr-lab">Sending screenshots to {p.name}</div>
          <div>
            <div className="sr-row">
              {p.agreedAt ? <span className="pic-ready">✓ You agreed on {day(p.agreedAt)}</span> : <span className="sr-help sr-none">You have not agreed to this yet. Choosing {p.name} asks you first.</span>}
            </div>
            {p.id === selected.id && (
              <div className="sr-help">
                {p.company} receives each unsure screenshot shrunk to {n(st.longEdge)} pixels, with the app name and window title from its file name. Window titles can name documents, people or folders. Choosing Off stops it.
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="sr">
        <div className="sr-lab">Second opinions</div>
        <div>
          <label className="as-switch">
            <input type="checkbox" role="switch" className="sorter-cloud-second-opinions" checked={st.settings.secondOpinions} disabled={busy} onChange={(e) => void setSecond(e.target.checked)} />
            <span className="as-switch-track" />
            <span className="as-switch-label">{st.settings.secondOpinions ? 'On' : 'Off'}</span>
          </label>
          <div className="sr-help">
            If {first.name} was unsure about a screenshot, {second.name} can be asked about it once, and the other way round. A screenshot both have answered is not sent again.
          </div>
          {secondError && <div className="pic-error">{secondError}</div>}
        </div>
      </div>

      <div className="sorter-pointer">
        <span>
          Training, sorting and the nightly run are in <b>Triage → Auto sorting</b>.
        </span>
        <button className="as-link sorter-open-auto" onClick={onOpenAutoSorting}>
          Open Auto sorting →
        </button>
      </div>
    </div>
  )
}
