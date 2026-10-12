// The period choice beside both sort buttons in Settings › Screenshot sorter: Last 7 days, Last 30
// days, Last 90 days or Everything. It is one setting, stored by main; this control only names one of
// the periods main listed. Main works out the cut-off from its own clock and refuses anything else.
import type { SortPeriod } from '../../preload'

export function SortPeriodSelect({ period, periods, disabled }: { period: SortPeriod | null; periods: ReadonlyArray<{ id: SortPeriod; label: string }>; disabled?: boolean }): JSX.Element {
  return (
    <label className="sorter-period">
      <span className="sorter-period-label">Period</span>
      <select
        className="sorter-period-select"
        aria-label="Period to sort"
        value={period ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const next = periods.find((p) => p.id === e.target.value)
          if (next) void window.sw.sorter.setPeriod(next.id) // both sections get the new status from main
        }}
      >
        {period === null && (
          <option value="" disabled>
            Choose a period
          </option>
        )}
        {periods.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}
