// The held-back accuracy report (Sorter vs Rules alone), the thresholds and the calibration note, as the
// Auto sorting tab shows them behind "Accuracy table and thresholds: show". Read only.
import type { SorterAccuracy, SorterReport } from '../../preload'
import { day, n, pct } from './sorter-format'

function AccuracyRow({ a, label }: { a: SorterAccuracy; label: string }): JSX.Element {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {pct(a.keep.precision)} <span className="sorter-count">{a.keep.proposed ? `${a.keep.correct} of ${a.keep.proposed}` : 'none proposed'}</span>
      </td>
      <td>
        {pct(a.throwaway.precision)} <span className="sorter-count">{a.throwaway.proposed ? `${a.throwaway.correct} of ${a.throwaway.proposed}` : 'none proposed'}</span>
      </td>
      <td>
        {pct(a.doubtful.share)} <span className="sorter-count">{`${a.doubtful.count} of ${a.sample}`}</span>
      </td>
    </tr>
  )
}

export function SorterAccuracyTable({ report }: { report: SorterReport }): JSX.Element {
  const a = report.heldBack
  return (
    <div className="sorter-report">
      <div className="sorter-report-head">
        Accuracy measured on a held-back fifth of your past choices ({n(a.sample)}: {n(a.truth.keep)} kept, {n(a.truth.throwaway)} binned); the model in use was then retrained on all your choices · {day(report.trainedAt)}
      </div>
      <table className="sorter-table">
        <thead>
          <tr>
            <th />
            <th>Keep right</th>
            <th>Throwaway right</th>
            <th>Need a look</th>
          </tr>
        </thead>
        <tbody>
          <AccuracyRow a={a} label="Sorter" />
          <AccuracyRow a={report.rulesOnly} label="Rules alone" />
        </tbody>
      </table>
      <div className="pic-note">
        {a.keptProposedThrowaway === 0 ? 'No screenshot you kept was proposed as throwaway.' : `${n(a.keptProposedThrowaway)} screenshot${a.keptProposedThrowaway === 1 ? '' : 's'} you kept would have been proposed as throwaway.`} Throwaway needs {pct(report.thresholds.throwaway)} certainty; keep needs {pct(report.thresholds.keep)}.
        {report.calibration ? ` Certainty is calibrated on your past choices (${report.calibration.chosen === 'platt' ? 'Platt scaling' : 'isotonic regression'}).` : ''}
      </div>
    </div>
  )
}
