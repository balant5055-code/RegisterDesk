// RD-EVENT-09 · Crash-recovery snapshot scheduler — PURE.
//
// No React, no localStorage, no timers of its own: the caller injects `write`, `schedule`
// and `cancel`. That keeps the coalescing logic testable in this repo's `node` vitest
// environment, where neither a DOM nor `requestIdleCallback` exists.
//
// ═══ WHAT PROBLEM THIS SOLVES ════════════════════════════════════════════════
// `useDraft.queue()` wrote the crash-recovery snapshot synchronously on every autosave
// emit — i.e. every keystroke — costing a full `JSON.stringify` of the ENTIRE draft plus a
// synchronous `localStorage.setItem` on the input path.
//
// This coalesces those writes: many keystrokes mark the snapshot dirty, one write happens.
//
// ═══ THE SAFETY RULES ════════════════════════════════════════════════════════
// A crash-recovery mechanism that lags is worse than useless, so the contract is:
//
//   1. `markDirty()` is cheap and idempotent. Only the FIRST call schedules; the rest just
//      keep the dirty flag set. This is what removes the per-keystroke cost.
//   2. `flushNow()` writes immediately if dirty, and is what the caller must invoke at every
//      point where the page may stop running (pagehide, visibility→hidden) or where an
//      accurate snapshot is required (before a network write).
//   3. `cancel()` drops a pending write WITHOUT writing — for when the snapshot has already
//      been superseded (e.g. a successful save just rewrote it with empty pendingKeys).
//      Without this, a late scheduled write could resurrect state that was just cleared.
//   4. After any of the three, no handle is left outstanding. A write never runs twice for
//      the same dirty period.

/** Opaque handle returned by the injected scheduler. */
export type ScheduleHandle = number

export interface SnapshotSchedulerDeps {
  /** Schedules `cb` for a later, non-blocking moment. Returns a cancellable handle. */
  schedule: (cb: () => void) => ScheduleHandle
  /** Cancels a previously scheduled callback. */
  cancel: (handle: ScheduleHandle) => void
}

export interface SnapshotScheduler {
  /**
   * Note that the snapshot is out of date. Cheap; safe to call on every keystroke.
   *
   * The writer is supplied HERE rather than at construction, for two reasons: the caller
   * builds it at event time (so it can read live refs without the scheduler ever holding
   * one), and the most recent writer always wins — a coalesced burst writes using the
   * newest closure, never the first keystroke's.
   */
  markDirty(write: () => void): void
  /** Write now if dirty. Used at page-hide and before a network write. */
  flushNow(): void
  /** Drop a pending write without performing it — the snapshot was superseded. */
  cancel(): void
  /** Test/introspection helper. */
  isDirty(): boolean
}

export function createSnapshotScheduler(deps: SnapshotSchedulerDeps): SnapshotScheduler {
  let dirty = false
  let handle: ScheduleHandle | null = null
  let write: (() => void) | null = null

  const clearHandle = () => {
    if (handle !== null) { deps.cancel(handle); handle = null }
  }

  const perform = () => {
    dirty = false
    const w = write
    write = null
    w?.()
  }

  return {
    markDirty(nextWrite) {
      dirty = true
      write = nextWrite
      // Already scheduled — coalesce into the pending write rather than stacking another.
      if (handle !== null) return
      handle = deps.schedule(() => {
        handle = null
        if (!dirty) return
        perform()
      })
    },

    flushNow() {
      clearHandle()
      if (!dirty) return
      perform()
    },

    cancel() {
      clearHandle()
      dirty = false
      write = null
    },

    isDirty() { return dirty },
  }
}
