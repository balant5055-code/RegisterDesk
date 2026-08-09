// MC-10.4 · Driver-run serialisation. Pure async — no React, no DOM.
//
// The upload driver exits on pause but takes time to wind down (it awaits the photos already
// in flight). A Resume pressed inside that window is the interesting case: without
// serialisation it starts a SECOND driver alongside the first, and because each driver keeps
// its own `dispatched` set, both can pick up the same queued photo and upload it twice.
//
// These tests pin the two properties that prevent that: never overlapping, and never stalling.

import { describe, it, expect } from 'vitest'
import { createSerialRunner } from '@/features/media-studio/utils/serialRunner'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

describe('createSerialRunner', () => {
  it('never runs two tasks at the same time', async () => {
    // The whole point: two concurrent drivers can double-upload one photo.
    const run = createSerialRunner()
    let active = 0
    let maxActive = 0

    const task = () => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick(10)
      active--
    }

    await Promise.all([run(task()), run(task()), run(task())])
    expect(maxActive).toBe(1)
  })

  it('runs tasks in the order they were queued', async () => {
    const run = createSerialRunner()
    const order: number[] = []
    const task = (n: number, ms: number) => async () => { await tick(ms); order.push(n) }

    // The first is the slowest — if ordering were by completion this would come out 3,2,1.
    await Promise.all([run(task(1, 30)), run(task(2, 10)), run(task(3, 0))])
    expect(order).toEqual([1, 2, 3])
  })

  it('a queued task waits for the one already running — the Resume-during-wind-down case', async () => {
    const run = createSerialRunner()
    const events: string[] = []

    // The driver winding down after a pause.
    const first = run(async () => {
      events.push('driver1:start')
      await tick(20)
      events.push('driver1:end')
    })
    // Resume pressed immediately, before driver 1 has finished.
    const second = run(async () => { events.push('driver2:start') })

    await Promise.all([first, second])
    expect(events).toEqual(['driver1:start', 'driver1:end', 'driver2:start'])
  })

  it('a FAILED task does not stall the chain', async () => {
    // A driver that throws must not strand every later Resume — that would trade a dead
    // button for a permanently dead queue.
    const run = createSerialRunner()
    const ran: string[] = []

    await run(async () => { throw new Error('driver blew up') }).catch(() => {})
    await run(async () => { ran.push('after') })

    expect(ran).toEqual(['after'])
  })

  it('a failed task does not reject later callers', async () => {
    const run = createSerialRunner()
    void run(async () => { throw new Error('boom') }).catch(() => {})
    // The next caller awaits its OWN task's outcome, not the previous failure.
    await expect(run(async () => { /* fine */ })).resolves.toBeUndefined()
  })

  it('the returned promise resolves when THAT task finishes, not the whole chain', async () => {
    const run = createSerialRunner()
    let secondDone = false

    const first = run(async () => { await tick(5) })
    void run(async () => { await tick(40); secondDone = true })

    await first
    expect(secondDone).toBe(false)
  })

  it('pause/resume pressed repeatedly queues one run each, still serial', async () => {
    // "Pause twice / resume twice" from the sprint's test list.
    const run = createSerialRunner()
    let active = 0, maxActive = 0, completed = 0

    const driver = () => async () => {
      active++; maxActive = Math.max(maxActive, active)
      await tick(5)
      active--; completed++
    }

    await Promise.all(Array.from({ length: 6 }, () => run(driver())))
    expect(maxActive).toBe(1)
    expect(completed).toBe(6)
  })

  it('is idle-safe — a run queued long after the chain drained starts immediately', async () => {
    const run = createSerialRunner()
    await run(async () => { await tick(5) })
    await tick(20)

    const started = Date.now()
    await run(async () => { /* immediate */ })
    expect(Date.now() - started).toBeLessThan(50)
  })
})
