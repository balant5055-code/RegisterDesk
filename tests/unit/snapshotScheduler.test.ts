// RD-EVENT-09 — the snapshot scheduler must never lose, duplicate, or resurrect a write.
//
// The scheduler is what makes deferring crash-recovery writes safe, so these tests are the
// safety contract, not a coverage exercise. Every rule in the module's header has a test.

import { describe, it, expect, vi } from 'vitest'
import { createSnapshotScheduler, type ScheduleHandle } from '@/lib/hooks/snapshotScheduler'

/** A controllable stand-in for requestIdleCallback. */
function harness() {
  const writes: number[] = []
  let seq = 0
  const pending = new Map<ScheduleHandle, () => void>()
  let nextHandle = 1

  const s = createSnapshotScheduler({
    schedule: cb => { const h = nextHandle++ as ScheduleHandle; pending.set(h, cb); return h },
    cancel: h => { pending.delete(h) },
  })

  return {
    s, writes,
    /** The writer handed to markDirty, as `queue()` does at event time. */
    w: () => { writes.push(++seq) },
    /** Fire every scheduled callback, as the browser eventually would. */
    runIdle() { const cbs = [...pending.values()]; pending.clear(); cbs.forEach(cb => cb()) },
    scheduled: () => pending.size,
  }
}

describe('coalescing — the whole point', () => {
  it('20 keystrokes produce ONE write', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.s.markDirty(h.w)
    expect(h.scheduled()).toBe(1)          // only the first keystroke scheduled anything
    expect(h.writes).toHaveLength(0)       // nothing written on the input path
    h.runIdle()
    expect(h.writes).toHaveLength(1)
  })

  it('a second burst after an idle write schedules again', () => {
    const h = harness()
    h.s.markDirty(h.w); h.runIdle()
    h.s.markDirty(h.w); h.runIdle()
    expect(h.writes).toHaveLength(2)
  })

  it('idle firing with nothing dirty writes nothing', () => {
    const h = harness()
    h.s.markDirty(h.w)
    h.s.flushNow()            // consumes the dirty state
    h.runIdle()               // a stale callback must not double-write
    expect(h.writes).toHaveLength(1)
  })
})

describe('flushNow — the no-data-loss guarantee', () => {
  it('writes immediately when dirty', () => {
    const h = harness()
    h.s.markDirty(h.w)
    h.s.flushNow()
    expect(h.writes).toHaveLength(1)
    expect(h.scheduled()).toBe(0)          // the pending callback was cancelled
  })

  it('is a no-op when clean, so hide/show cycles do not write repeatedly', () => {
    const h = harness()
    h.s.flushNow(); h.s.flushNow(); h.s.flushNow()
    expect(h.writes).toHaveLength(0)
  })

  it('never writes twice for one dirty period', () => {
    const h = harness()
    h.s.markDirty(h.w)
    h.s.flushNow()
    h.s.flushNow()
    h.runIdle()
    expect(h.writes).toHaveLength(1)
  })

  it('rapid typing then an immediate page-hide loses nothing', () => {
    const h = harness()
    for (let i = 0; i < 50; i++) h.s.markDirty(h.w)
    h.s.flushNow()                          // pagehide fires before any idle moment
    expect(h.writes).toHaveLength(1)
    expect(h.s.isDirty()).toBe(false)
  })
})

describe('cancel — preventing a superseded write from resurrecting state', () => {
  it('drops a pending write without performing it', () => {
    const h = harness()
    h.s.markDirty(h.w)
    h.s.cancel()
    h.runIdle()
    expect(h.writes).toHaveLength(0)
    expect(h.s.isDirty()).toBe(false)
  })

  it('a save that succeeds mid-burst cannot be undone by a late idle write', () => {
    // This is the exact race: queue() marks dirty, the network save completes and
    // clearPendingSnapshot() rewrites the snapshot with pendingKeys: [], then the idle
    // callback fires. Without cancel(), it would re-add the keys just cleared.
    const h = harness()
    h.s.markDirty(h.w)
    h.s.cancel()                            // what clearPendingSnapshot() does
    h.runIdle()
    expect(h.writes).toHaveLength(0)
  })

  it('marking dirty after a cancel schedules a fresh write', () => {
    const h = harness()
    h.s.markDirty(h.w); h.s.cancel()
    h.s.markDirty(h.w); h.runIdle()
    expect(h.writes).toHaveLength(1)
  })
})

describe('no handle is ever left outstanding', () => {
  it('after flushNow', () => {
    const h = harness(); h.s.markDirty(h.w); h.s.flushNow(); expect(h.scheduled()).toBe(0)
  })
  it('after cancel', () => {
    const h = harness(); h.s.markDirty(h.w); h.s.cancel(); expect(h.scheduled()).toBe(0)
  })
  it('after the idle callback runs', () => {
    const h = harness(); h.s.markDirty(h.w); h.runIdle(); expect(h.scheduled()).toBe(0)
  })
})

describe('the newest writer wins, and it reads state when it RUNS', () => {
  it('a coalesced burst writes the latest pending keys, not the first keystroke\'s', () => {
    // In useDraft the writer closes over `pendingRef` and reads it inside the call. If the
    // scheduler kept the FIRST writer, a burst would persist a stale key set.
    let keys: string[] = []
    const captured: string[][] = []
    const pending = new Map<ScheduleHandle, () => void>()
    const s = createSnapshotScheduler({
      schedule: cb => { pending.set(1 as ScheduleHandle, cb); return 1 as ScheduleHandle },
      cancel: h => { pending.delete(h) },
    })
    const writer = () => captured.push([...keys])

    keys = ['pricing'];                                     s.markDirty(writer)
    keys = ['pricing', 'registrationForm'];                 s.markDirty(writer)
    keys = ['pricing', 'registrationForm', 'eventDetails']; s.markDirty(writer)
    pending.get(1 as ScheduleHandle)!()

    expect(captured).toEqual([['pricing', 'registrationForm', 'eventDetails']])
  })

  it('the most recently supplied writer is the one invoked', () => {
    const order: string[] = []
    const pending = new Map<ScheduleHandle, () => void>()
    const s = createSnapshotScheduler({
      schedule: cb => { pending.set(1 as ScheduleHandle, cb); return 1 as ScheduleHandle },
      cancel: h => { pending.delete(h) },
    })
    s.markDirty(() => order.push('first'))
    s.markDirty(() => order.push('second'))
    pending.get(1 as ScheduleHandle)!()
    expect(order).toEqual(['second'])
  })
})

describe('scheduler injection', () => {
  it('schedules exactly once per dirty period, and cancels exactly what it scheduled', () => {
    const schedule = vi.fn(() => 42 as ScheduleHandle)
    const cancel = vi.fn()
    const s = createSnapshotScheduler({ schedule, cancel })
    const w = () => {}
    s.markDirty(w); s.markDirty(w); s.markDirty(w)
    expect(schedule).toHaveBeenCalledTimes(1)
    s.flushNow()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(42)
  })
})
