// RD-MC-CUSTOM-01 · How many credits an organizer may buy. Pure — no config, no network.
//
// The rule the brief states as inviolable: never allow an organizer to buy credits they
// cannot use. Every test here is a way that could go wrong.

import { describe, it, expect } from 'vitest'
import {
  MIN_CUSTOM_PURCHASE, isWithinCapacity, purchaseCapacity,
} from '@/features/media-credits/utils/creditPacks'
import { MAX_CREDITS_PER_PURCHASE } from '@/features/media-credits/utils/purchaseFlow'

describe("purchaseCapacity — the brief's worked examples", () => {
  it('Free: 50 max, 32 uploaded, 5 in wallet → 13', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 32, walletAvailable: 5 })
    expect(c.remaining).toBe(13)
    expect(c.canPurchase).toBe(true)
    expect(c.min).toBe(10)
    expect(c.max).toBe(13)
  })

  it('Free: remaining 23 → allowed 10–23', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 27, walletAvailable: 0 })
    expect([c.min, c.max]).toEqual([10, 23])
  })

  it('Starter: remaining 420 → allowed 10–420', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 500, uploadedPhotos: 68, walletAvailable: 12 })
    expect([c.min, c.max]).toEqual([10, 420])
  })

  it('Business: remaining 1800 → allowed 10–1800', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 3_000, uploadedPhotos: 1_100, walletAvailable: 100 })
    expect([c.min, c.max]).toEqual([10, 1_800])
  })
})

describe('credits already held are subtracted', () => {
  it('a wallet balance reduces what may be bought', () => {
    // 13 slots free but 5 credits already held ⇒ only 8 usable. Selling 13 would sell 5
    // the organizer can never spend.
    const withWallet = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 32, walletAvailable: 5 })
    const without    = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 32, walletAvailable: 0 })
    expect(withWallet.remaining).toBe(13)
    expect(without.remaining).toBe(18)
  })

  it('a wallet that already fills the plan blocks purchasing', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 0, walletAvailable: 50 })
    expect(c.remaining).toBe(0)
    expect(c.canPurchase).toBe(false)
  })
})

describe('the minimum', () => {
  it('blocks purchasing below the minimum rather than offering a smaller order', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 41, walletAvailable: 0 })
    expect(c.remaining).toBe(9)
    expect(c.canPurchase).toBe(false)
    expect(c.max).toBe(0)
  })

  it('exactly the minimum is allowed', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 40, walletAvailable: 0 })
    expect(c.remaining).toBe(MIN_CUSTOM_PURCHASE)
    expect(c.canPurchase).toBe(true)
  })
})

describe('never negative, never NaN', () => {
  it('over-quota does not produce a negative capacity', () => {
    // The multi-event case that motivated the event selector: uploads can exceed one
    // event's limit if the data is inconsistent. It must clamp, not go negative.
    const c = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 120, walletAvailable: 5 })
    expect(c.remaining).toBe(0)
    expect(c.canPurchase).toBe(false)
  })

  it('corrupt inputs contribute zero rather than NaN', () => {
    const c = purchaseCapacity({
      maxPhotosPerEvent: Number.NaN,
      uploadedPhotos: 'x' as unknown as number,
      walletAvailable: -5,
    })
    expect(Number.isFinite(c.remaining)).toBe(true)
    expect(c.remaining).toBe(0)
  })
})

describe('an unlimited plan', () => {
  it('is bounded only by the per-purchase ceiling', () => {
    const c = purchaseCapacity({ maxPhotosPerEvent: null, uploadedPhotos: 9_999, walletAvailable: 500 })
    expect(c.unlimited).toBe(true)
    expect(c.canPurchase).toBe(true)
    expect(c.max).toBe(MAX_CREDITS_PER_PURCHASE)
  })
})

describe("isWithinCapacity — the server's rule", () => {
  const cap = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 32, walletAvailable: 5 })

  it('accepts inside the range, inclusive at both ends', () => {
    expect(isWithinCapacity(10, cap)).toBe(true)
    expect(isWithinCapacity(13, cap)).toBe(true)
    expect(isWithinCapacity(11, cap)).toBe(true)
  })

  it('rejects above the maximum — the client-bypass case', () => {
    expect(isWithinCapacity(14, cap)).toBe(false)
    expect(isWithinCapacity(10_000, cap)).toBe(false)
  })

  it('rejects below the minimum', () => {
    expect(isWithinCapacity(9, cap)).toBe(false)
    expect(isWithinCapacity(0, cap)).toBe(false)
    expect(isWithinCapacity(-5, cap)).toBe(false)
  })

  it('rejects non-integers and NaN', () => {
    expect(isWithinCapacity(10.5, cap)).toBe(false)
    expect(isWithinCapacity(Number.NaN, cap)).toBe(false)
    expect(isWithinCapacity(Infinity, cap)).toBe(false)
  })

  it('rejects everything when purchasing is blocked', () => {
    const blocked = purchaseCapacity({ maxPhotosPerEvent: 50, uploadedPhotos: 45, walletAvailable: 0 })
    expect(isWithinCapacity(5, blocked)).toBe(false)
    expect(isWithinCapacity(10, blocked)).toBe(false)
  })
})
