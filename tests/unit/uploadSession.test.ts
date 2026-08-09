// MC-10.2 · Credit slot allocation for an upload batch. Pure — no React, no network.
//
// The properties here are the ones that decide whether a retry costs one credit or two.

import { describe, it, expect } from 'vitest'
import { assignSlots, newUploadSessionId } from '@/features/media-studio/utils/uploadSession'

const item = (id: string, state = 'queued', sessionId: string | null = null) =>
  ({ id, state, sessionId })

describe('assignSlots — one session per batch', () => {
  it('gives every queued photo the SAME session', () => {
    const out = assignSlots([item('a'), item('b'), item('c')], 'us_1')
    expect(out.map(s => s.sessionId)).toEqual(['us_1', 'us_1', 'us_1'])
  })

  it('numbers slots 0…N-1 with no gaps and no duplicates', () => {
    const out = assignSlots(['a', 'b', 'c', 'd', 'e'].map(id => item(id)), 'us_1')
    expect(out.map(s => s.slotIndex)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(out.map(s => s.slotIndex)).size).toBe(5)
  })

  it('reports the batch size on every member', () => {
    // The server opens the session to hold exactly this many credits, so a member
    // disagreeing about the count would place its slot outside the allocation.
    const out = assignSlots([item('a'), item('b')], 'us_1')
    expect(out.every(s => s.sessionSlots === 2)).toBe(true)
  })

  it('scales to a large batch without drift', () => {
    const many = Array.from({ length: 100 }, (_, i) => item(`q${i}`))
    const out = assignSlots(many, 'us_big')
    expect(out).toHaveLength(100)
    expect(out.map(s => s.slotIndex)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(out.every(s => s.sessionSlots === 100)).toBe(true)
  })
})

describe('assignSlots — a retry keeps its slot', () => {
  it('skips items that already belong to a session', () => {
    // This is the double-charge guard. A new slot would derive a new assetId, consuming a
    // second allocation for one photo and stranding the first until the sweep reclaimed it.
    const out = assignSlots([
      item('a', 'queued', 'us_old'),   // retried — already slotted
      item('b', 'queued', 'us_old'),   // retried — already slotted
      item('c'),                        // genuinely new
    ], 'us_new')

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ id: 'c', sessionId: 'us_new', slotIndex: 0, sessionSlots: 1 })
  })

  it('assigns NOTHING when every queued item is already slotted', () => {
    // A pure retry. The caller mints no session and the server is never asked to open one.
    const out = assignSlots([
      item('a', 'queued', 'us_old'), item('b', 'queued', 'us_old'),
    ], 'us_new')
    expect(out).toEqual([])
  })

  it('sizes the new session to the NEW items only', () => {
    // Counting retries would hold credits for slots already accounted for in another session.
    const out = assignSlots([
      item('a', 'queued', 'us_old'),
      item('b'), item('c'), item('d'),
    ], 'us_new')
    expect(out.every(s => s.sessionSlots === 3)).toBe(true)
    expect(out.map(s => s.slotIndex)).toEqual([0, 1, 2])
  })
})

describe('assignSlots — which states get a slot', () => {
  it('slots queued and paused items', () => {
    // A paused item restarts from the beginning on resume, so it still needs its slot.
    const out = assignSlots([item('a', 'queued'), item('b', 'paused')], 'us_1')
    expect(out.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('never slots a terminal or in-flight item', () => {
    for (const state of ['completed', 'cancelled', 'uploading', 'processing', 'duplicate']) {
      expect(assignSlots([item('x', state)], 'us_1')).toEqual([])
    }
  })

  it('a cancelled item consumes no slot, so the batch numbering closes over it', () => {
    const out = assignSlots([
      item('a'), item('b', 'cancelled'), item('c'),
    ], 'us_1')
    expect(out.map(s => s.id)).toEqual(['a', 'c'])
    expect(out.map(s => s.slotIndex)).toEqual([0, 1])   // no gap where 'b' was
    expect(out.every(s => s.sessionSlots === 2)).toBe(true)
  })

  it('an empty queue assigns nothing', () => {
    expect(assignSlots([], 'us_1')).toEqual([])
  })
})

describe('newUploadSessionId', () => {
  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newUploadSessionId()))
    expect(ids.size).toBe(200)
  })

  it('is opaque and prefixed, never a raw counter', () => {
    // A predictable id would let one workspace guess another's session id. It would still be
    // refused — the server re-checks ownership on every slot claim — but guessable ids in a
    // financial path are not worth the argument.
    expect(newUploadSessionId()).toMatch(/^us_[a-z0-9]+_[a-z0-9]+$/)
  })
})
