// MC-06A · Slot addressing and bounds. Pure — no Firestore, no emulator.
//
// These assert the property the whole session model rests on: usage cannot exceed the
// allocation, and that bound is enforced by arithmetic rather than by a counter.

import { describe, it, expect } from 'vitest'
import {
  MAX_SESSION_SLOTS, creditsForSlots, deriveAssetId, resolveSlot,
} from '@/features/media-credits/utils/sessionSlots'

const SESSION = 'sess_abc123'

describe('deriveAssetId', () => {
  it('is deterministic — the same slot always yields the same assetId', () => {
    // THE property replay protection depends on: a retried upload must land on the same
    // reservation document, or `create` cannot recognise it as a duplicate.
    expect(deriveAssetId(SESSION, 7)).toBe(deriveAssetId(SESSION, 7))
  })

  it('is unique per slot and per session', () => {
    expect(deriveAssetId(SESSION, 0)).not.toBe(deriveAssetId(SESSION, 1))
    expect(deriveAssetId('sess_other', 0)).not.toBe(deriveAssetId(SESSION, 0))
  })

  it('produces no collision across 1000 slots', () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, i) => deriveAssetId(SESSION, i)))
    expect(ids.size).toBe(1000)
  })
})

describe('resolveSlot', () => {
  it('accepts every slot inside the bound', () => {
    for (const i of [0, 1, 49, 99]) {
      expect(resolveSlot(SESSION, i, 100)).toEqual({ ok: true, assetId: deriveAssetId(SESSION, i) })
    }
  })

  it('rejects the slot exactly at the bound', () => {
    // Off-by-one here would let a session upload N+1 photos on N credits.
    expect(resolveSlot(SESSION, 100, 100)).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('rejects anything beyond the bound', () => {
    expect(resolveSlot(SESSION, 101, 100).ok).toBe(false)
    expect(resolveSlot(SESSION, 1_000_000, 100).ok).toBe(false)
  })

  it('rejects a negative index', () => {
    expect(resolveSlot(SESSION, -1, 100)).toEqual({ ok: false, reason: 'negative' })
  })

  it.each([1.5, NaN, Infinity])('rejects a non-integer index (%s)', idx => {
    expect(resolveSlot(SESSION, idx, 100)).toEqual({ ok: false, reason: 'not_an_integer' })
  })

  it('a zero-slot session admits nothing', () => {
    expect(resolveSlot(SESSION, 0, 0).ok).toBe(false)
  })
})

describe('creditsForSlots', () => {
  it('multiplies slots by the per-photo cost', () => {
    expect(creditsForSlots(100, 1)).toBe(100)
    expect(creditsForSlots(100, 2)).toBe(200)
  })

  it('truncates, matching pricingService.creditsForPhotos', () => {
    // A session and a purchase must price photos identically, or the credits held differ
    // from the credits sold.
    expect(creditsForSlots(10.9, 1)).toBe(10)
    expect(creditsForSlots(10, 1.9)).toBe(10)
  })

  it('never returns a negative allocation', () => {
    expect(creditsForSlots(-5, 1)).toBe(0)
    expect(creditsForSlots(5, -1)).toBe(0)
  })

  it('the session cap is a sane guard', () => {
    expect(MAX_SESSION_SLOTS).toBeGreaterThanOrEqual(1000)
  })
})
