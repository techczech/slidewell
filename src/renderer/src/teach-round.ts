// The round of ten (ticket 24): the small store that lets any "Teach the sorter (10)" button open the round without
// knowing where it is mounted (TeachRoundHost, once, in App), and that carries "See what moved" over to Review,
// which may not be mounted yet when the round is left from Triage.
import { useSyncExternalStore } from 'react'

let open = false
let pendingMoved: string[] | null = null
const openSubs = new Set<() => void>()
const movedSubs = new Set<() => void>()
const emit = (subs: Set<() => void>): void => subs.forEach((f) => f())

/** Opens the round over whichever view he is in. */
export function startTeachingRound(): void {
  if (open) return
  open = true
  emit(openSubs)
}
export function closeTeachingRound(): void {
  if (!open) return
  open = false
  emit(openSubs)
}
/** Calls `cb` each time the round opens, in the same call that opens it (so a panel can close in the same click). Returns the unsubscribe. */
export function onTeachingRoundOpen(cb: () => void): () => void {
  const f = (): void => {
    if (open) cb()
  }
  openSubs.add(f)
  return () => {
    openSubs.delete(f)
  }
}
export function useTeachingRoundOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      openSubs.add(cb)
      return () => openSubs.delete(cb)
    },
    () => open
  )
}

/** "See what moved" from the result: closes the round and asks Review to open the moved view for these screenshots. */
export function showMovedInReview(hashes: string[]): void {
  pendingMoved = hashes
  closeTeachingRound()
  emit(movedSubs)
}
/** Review calls this on mount and when asked: the hashes waiting to be shown, once. */
export function takePendingMoved(): string[] | null {
  const h = pendingMoved
  pendingMoved = null
  return h
}
export function onMovedRequest(cb: () => void): () => void {
  movedSubs.add(cb)
  return () => movedSubs.delete(cb)
}
