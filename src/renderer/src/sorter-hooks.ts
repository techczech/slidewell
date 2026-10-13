// The sorter's two status stores (local sorter, cloud step) as hooks, shared by the Auto sorting tab,
// Settings › Screenshot sorter and the title bar's "sorting" dot. Main owns both; these only read.
import { useEffect, useState } from 'react'
import type { CloudStatus, SortRun, SorterLearning, SorterStatus } from '../../preload'

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

/** The sorts kept by main, newest first; read again when `key` changes (a sort ended, a service run finished). `version` rises on each read. */
export function useSortRuns(key: string): { runs: SortRun[]; version: number } {
  const [state, setState] = useState<{ runs: SortRun[]; version: number }>({ runs: [], version: 0 })
  useEffect(() => {
    let live = true
    void window.sw.sorter.runs().then((runs) => live && setState((s) => ({ runs, version: s.version + 1 })))
    return () => {
      live = false
    }
  }, [key])
  return state
}

/**
 * "How much is enough": main works it out once per training (tens of seconds the first time), so `learning` stays null
 * while it is being worked out and nothing waits on it. Read again when the training changes (`key`).
 */
export function useLearning(key: string): { learning: SorterLearning | null; working: boolean; failed: boolean } {
  const [state, setState] = useState<{ key: string; learning: SorterLearning | null; failed: boolean }>({ key: '', learning: null, failed: false })
  useEffect(() => {
    let live = true
    void window.sw.sorter
      .learning()
      .then((l) => live && setState({ key, learning: l, failed: false }))
      .catch(() => live && setState({ key, learning: null, failed: true }))
    return () => {
      live = false
    }
  }, [key])
  return { learning: state.learning, working: state.key !== key, failed: state.failed }
}
