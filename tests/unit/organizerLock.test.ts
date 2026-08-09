// MC-05.6B · Per-organizer serialisation. Pure — no Firestore, no emulator.

import { describe, it, expect } from 'vitest'
import {
  LOCK_TIMEOUT_MS, inFlightOrganizers, withOrganizerLock,
} from '@/features/media-credits/utils/organizerLock'

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe('withOrganizerLock', () => {
  it('runs work for ONE organizer strictly one at a time', async () => {
    const events: string[] = []
    const job = (name: string) => withOrganizerLock('org-a', async () => {
      events.push(`${name}:start`)
      await tick(20)
      events.push(`${name}:end`)
    })

    await Promise.all([job('a'), job('b'), job('c')])

    // No interleaving: every start is immediately followed by its own end.
    expect(events).toEqual([
      'a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end',
    ])
  })

  it('does NOT serialise across different organizers', async () => {
    const events: string[] = []
    const job = (uid: string, name: string) => withOrganizerLock(uid, async () => {
      events.push(`${name}:start`)
      await tick(30)
      events.push(`${name}:end`)
    })

    await Promise.all([job('org-x', 'x'), job('org-y', 'y')])

    // Both start before either ends — separate wallets never contend, so queueing them
    // together would be pure lost throughput.
    expect(events.slice(0, 2).sort()).toEqual(['x:start', 'y:start'])
  })

  it('returns the value the work produced', async () => {
    await expect(withOrganizerLock('org-b', async () => 42)).resolves.toBe(42)
  })

  it('propagates a rejection to the caller', async () => {
    await expect(withOrganizerLock('org-c', async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')
  })

  it('a failed operation does not poison the queue behind it', async () => {
    const failing = withOrganizerLock('org-d', async () => { throw new Error('boom') })
    const after   = withOrganizerLock('org-d', async () => 'ok')

    await expect(failing).rejects.toThrow('boom')
    await expect(after).resolves.toBe('ok')
  })

  it('preserves FIFO order under a burst', async () => {
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withOrganizerLock('org-e', async () => { await tick(2); order.push(i) })),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('releases the key once the queue drains, so the map cannot grow unbounded', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withOrganizerLock(`org-drain-${i}`, async () => tick(1))),
    )
    await tick(20)   // the cleanup is scheduled on the chain, one turn behind
    expect(inFlightOrganizers()).toBe(0)
  })

  it('the timeout is long enough not to fire during normal work', () => {
    // Guards against someone lowering it to a value a real credit transaction could exceed:
    // measured worst case under contention was ~25s, and the lock removes that contention.
    expect(LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })
})
