// Native preparation begins only after this process has stopped accepting new work.
export function createRestartWork() {
  let active = 0
  let locked = false

  // Every background job that writes must be wrapped by run so the restart can wait for it.
  function run<T>(work: () => T): T {
    if (locked) throw new Error('SlideWell is restarting to finish an update.')
    active++
    try {
      const result = work()
      if (result instanceof Promise) return result.finally(() => { active-- }) as T
      active--
      return result
    } catch (error) {
      active--
      throw error
    }
  }

  return {
    run,
    busy: () => active > 0,
    locked: () => locked,
    freeze(): boolean {
      if (locked || active > 0) return false
      locked = true
      return true
    },
    release(): void { locked = false }
  }
}

export const restartWork = createRestartWork()
