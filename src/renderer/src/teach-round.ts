// TICKET 24 (not built here): the round of ten. The reading's "Teach the sorter (10)" button calls this and nothing else.
// Until ticket 24 lands it does nothing, so the button is present but inert.
export function startTeachingRound(): void {
  // intentionally empty: ticket 24 replaces this body (it opens the round of ten and ends with sorter.retrainNow('round'))
}
