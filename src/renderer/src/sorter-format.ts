// Number and time wording shared by the Auto sorting tab, its confirm box and Settings › Screenshot sorter.
export const n = (x: number): string => x.toLocaleString('en-GB')
export const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`)
export const day = (iso: string): string => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const usd = (x: number): string => (x < 0.01 ? 'under $0.01' : `about $${x.toFixed(2)}`)
export const plural = (x: number, one: string, many = `${one}s`): string => `${n(x)} ${x === 1 ? one : many}`

/** "today 02:00", "yesterday 02:00", else "Tue 13 Oct, 02:00". */
export function whenShort(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const midnight = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(d)) / 86400000)
  return days === 0 ? `today ${time}` : days === 1 ? `yesterday ${time}` : when(iso)
}
