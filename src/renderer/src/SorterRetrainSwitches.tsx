// Triage › Auto sorting › Training: the two retraining switches (ticket 23). "Retrain by itself after every ten answers"
// and "Not while on battery" (off = also retrain on battery; disabled while the first is off). Main stores both;
// the pushed sorter status brings the stored values back.
import { useState } from 'react'
import type { SorterStatus } from '../../preload'

export function SorterRetrainSwitches({ st }: { st: SorterStatus }): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const set = async (patch: { enabled?: boolean; onBattery?: boolean }): Promise<void> => {
    const r = await window.sw.sorter.setAutoRetrain(patch)
    setError(r.ok ? null : (r.error ?? 'The setting was not changed.'))
  }
  return (
    <div className="as-retrain-switches">
      <div>
        <label className="as-switch">
          <input type="checkbox" role="switch" className="as-auto-retrain" checked={st.autoRetrain} onChange={(e) => void set({ enabled: e.target.checked })} />
          <span className="as-switch-track" />
          <span className="as-switch-label">Retrain by itself after every ten answers</span>
        </label>
      </div>
      <div>
        <label className="as-switch">
          <input type="checkbox" role="switch" className="as-not-on-battery" checked={!st.autoRetrainOnBattery} disabled={!st.autoRetrain} onChange={(e) => void set({ onBattery: !e.target.checked })} />
          <span className="as-switch-track" />
          <span className="as-switch-label">Not while on battery</span>
        </label>
      </div>
      <p className="as-muted">Training takes a few minutes. With the second switch on, ten answers made on battery wait until the Mac is plugged in, or until you press Retrain now in Review.</p>
      {error && <p className="pic-error">{error}</p>}
    </div>
  )
}
