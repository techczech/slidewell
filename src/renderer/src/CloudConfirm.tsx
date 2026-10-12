// The confirm box raised by Sort now when a service is on: how many screenshots would go, to whom, in how
// many requests, at what estimated cost, and what is sent with each. Nothing is sent until its button is
// clicked; main then sends only the batch it prepared (the one-time token) and checks it once more.
import type { CloudPreview, CloudStatus } from '../../preload'
import { n, usd } from './sorter-format'

export function CloudConfirm({ preview, status, onCancel, onSend }: { preview: CloudPreview; status: CloudStatus; onCancel: () => void; onSend: () => void }): JSX.Element | null {
  // the batch names the provider it was prepared for
  const prepared = status.providers.find((p) => p.id === preview.provider)
  if (!prepared) return null
  return (
    <div className="overlay sorter-cloud-overlay" onClick={onCancel}>
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
          With each picture, shrunk to {n(status.longEdge)} pixels, {prepared.company} receives the app name and window title from the file name. Window titles can name
          documents, people or folders. The file’s folder and the text read from the picture are not sent.
        </p>
        <p>If {prepared.name} is unsure, they stay in Review.</p>
        <div className="sorter-cloud-confirm-btns">
          <button className="copyref" onClick={onCancel}>
            Not now
          </button>
          <button className="pic-primary sorter-cloud-send" autoFocus onClick={onSend}>
            Send {n(preview.toSend)} to {prepared.name}
          </button>
        </div>
      </div>
    </div>
  )
}
