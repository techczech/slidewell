// "How much is enough" chart (frames B3 / A3): two panels over the same choices axis, drawn as inline SVG with
// theme colours from CSS variables. The same values are in a visually hidden table, so nothing is only in the picture.
import type { SorterLearning } from '../../preload'
import { CHART, chartModel, chartRows } from './teach-format'

export function LearningChart({ learning }: { learning: Pick<SorterLearning, 'points' | 'minimum'> }): JSX.Element {
  const m = chartModel(learning)
  const rows = chartRows(learning.points)
  const label = `Chart of what the sorter gets right as it learns from more of your choices. ${rows.map((r) => `At ${r.choices} choices: throwaway right ${r.throwawayRight}, need a look ${r.needALook}.`).join(' ')}${m.minimumX !== null ? ` Fewer than ${learning.minimum} choices is too few to sort.` : ''}`
  return (
    <figure className="lc-fig">
      <svg className="lc-svg" viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-label={label}>
        {m.minimumX !== null && <rect className="lc-band" x={CHART.left} y={CHART.top} width={m.minimumX - CHART.left} height={CHART.bottom - CHART.top} />}
        {[...m.topTicks, ...m.lowTicks].map((t) => (
          <g key={`${t.y}-${t.label}`}>
            <line className="lc-grid" x1={CHART.left} x2={CHART.right} y1={t.y} y2={t.y} />
            <text className="lc-axis" x={CHART.left - 8} y={t.y + 4} textAnchor="end">{t.label}</text>
          </g>
        ))}
        <text className="lc-title lc-title-ta" x={CHART.left} y={18}>Throwaway right</text>
        <text className="lc-sub" x={CHART.left + 112} y={18}>of those it called throwaway, on the held-back sample</text>
        <text className="lc-title lc-title-nl" x={CHART.left} y={m.boundary}>Needs a look</text>
        <text className="lc-sub" x={CHART.left + 84} y={m.boundary}>share it was not sure about</text>
        {m.minimumX !== null && (
          <>
            <line className="lc-min" x1={m.minimumX} x2={m.minimumX} y1={CHART.top} y2={CHART.bottom} />
            <text className="lc-min-t" x={CHART.left + 8} y={CHART.bottom - 8}>Too few to sort</text>
            <text className="lc-min-t" x={m.minimumX + 8} y={44}>Minimum: {learning.minimum}</text>
          </>
        )}
        {(['throwaway', 'needALook'] as const).map((k) => (
          <g key={k} className={k === 'throwaway' ? 'lc-ta' : 'lc-nl'}>
            {m[k].line.map((pts) => <polyline key={pts} className="lc-line" points={pts} />)}
            {m[k].dots.map((d) => (
              <g key={d.x}>
                <circle className={d.last ? 'lc-dot lc-last' : 'lc-dot'} cx={d.x} cy={d.y} r={d.last ? 6 : 4.5} />
                <text className={d.last ? 'lc-val lc-val-last' : 'lc-val'} x={d.x} y={d.y - 12} textAnchor="middle">{d.label}</text>
              </g>
            ))}
          </g>
        ))}
        {m.xTicks.map((t) => <text key={t.x} className="lc-x" x={t.x} y={342} textAnchor="middle">{t.label}</text>)}
        <text className="lc-axis" x={(CHART.left + CHART.right) / 2} y={364} textAnchor="middle">Choices you have made (kept or thrown away)</text>
      </svg>
      <table className="lc-sr">
        <caption>What the sorter gets right at each number of choices, tested on the same held-back sample</caption>
        <thead><tr><th>Choices</th><th>Throwaway right</th><th>Need a look</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.choices}><td>{r.choices}</td><td>{r.throwawayRight}</td><td>{r.needALook}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}
