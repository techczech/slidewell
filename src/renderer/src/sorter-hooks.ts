// The sorter's two status stores (local sorter, cloud step) as hooks, shared by the Auto sorting tab,
// Settings › Screenshot sorter and the title bar's "sorting" dot. Main owns both; these only read.
import { useEffect, useState } from 'react'
import type { CloudStatus, SorterStatus } from '../../preload'

export function useSorterStatus(): SorterStatus | null {
  const [st, setSt] = useState<SorterStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.sorter.status().then((s) => live && setSt(s))
    const off = window.sw.sorter.onStatus((s) => setSt(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return st
}

export function useCloudStatus(): [CloudStatus | null, (s: CloudStatus) => void] {
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

/** Whether the local sorter is embedding, training or sorting. */
export const sorterRunning = (st: SorterStatus | null): boolean => st !== null && (st.phase === 'embedding' || st.phase === 'training' || st.phase === 'sorting')

/** Whether anything is running (local or cloud), for the dot on the Triage tab. */
export function useSorterBusy(): boolean {
  const st = useSorterStatus()
  const [cl] = useCloudStatus()
  return sorterRunning(st) || (cl !== null && cl.phase !== 'idle')
}
