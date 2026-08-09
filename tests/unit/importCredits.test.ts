// MS-IMPORT-01 · The affordability rule behind the Import page's Start gate.
//
// Pure — no React, no network. This is the logic that decides whether an organizer may press
// Start, and it is shared by the card's warnings and the button's disabled state precisely so
// the two cannot disagree. Worth testing directly rather than by reading the rendered page.

import { describe, it, expect } from 'vitest'
import {
  LOW_BALANCE_THRESHOLD, creditVerdict, estimateCost,
} from '@/features/media-studio/components/ImportCreditsCard'

describe('estimateCost', () => {
  it('multiplies photos by the server-reported cost basis', () => {
    expect(estimateCost(100, 1)).toBe(100)
    expect(estimateCost(100, 2)).toBe(200)
  })

  it('truncates, matching pricingService.creditsForPhotos', () => {
    // The estimate shown and the amount the session actually holds must agree; they would
    // not if one rounded and the other truncated.
    expect(estimateCost(10.9, 1)).toBe(10)
    expect(estimateCost(10, 1.9)).toBe(10)
  })

  it('never returns a negative cost', () => {
    expect(estimateCost(-5, 1)).toBe(0)
    expect(estimateCost(5, -1)).toBe(0)
  })

  it('an empty queue costs nothing', () => {
    expect(estimateCost(0, 5)).toBe(0)
  })
})

describe('creditVerdict', () => {
  it('is OK with comfortable headroom', () => {
    expect(creditVerdict({ available: 1000, cost: 100, photoCount: 100 })).toBe('ok')
  })

  it('is INSUFFICIENT when the import costs more than is available', () => {
    expect(creditVerdict({ available: 50, cost: 100, photoCount: 100 })).toBe('insufficient')
  })

  it('spending the balance exactly is allowed, not refused', () => {
    // Off-by-one here would block a legitimate upload that the server would have accepted.
    expect(creditVerdict({ available: 100, cost: 100, photoCount: 100 })).not.toBe('insufficient')
  })

  it('is LOW when little remains afterwards', () => {
    expect(creditVerdict({
      available: 100, cost: 100 - (LOW_BALANCE_THRESHOLD - 1), photoCount: 10,
    })).toBe('low')
  })

  it('an EMPTY queue is never insufficient', () => {
    // Nothing has been asked for yet. Warning on a page the organizer has only just opened
    // would be noise, and would disable Start for a reason they cannot act on.
    expect(creditVerdict({ available: 0, cost: 0, photoCount: 0 })).toBe('ok')
  })

  it('a zero balance with photos queued IS insufficient', () => {
    expect(creditVerdict({ available: 0, cost: 1, photoCount: 1 })).toBe('insufficient')
  })

  it('the low-balance threshold is a usable figure', () => {
    expect(LOW_BALANCE_THRESHOLD).toBeGreaterThan(0)
  })
})

describe('the gate and the warning agree', () => {
  it('Start is disabled exactly when the card says insufficient', () => {
    // The property that matters: one rule, two consumers. A disabled button beside a card
    // showing no warning is the failure this shares a function to prevent.
    const cases = [
      { available: 0,    photoCount: 10, perPhoto: 1 },
      { available: 9,    photoCount: 10, perPhoto: 1 },
      { available: 10,   photoCount: 10, perPhoto: 1 },
      { available: 1000, photoCount: 10, perPhoto: 1 },
      { available: 100,  photoCount: 10, perPhoto: 20 },
    ]
    for (const c of cases) {
      const cost = estimateCost(c.photoCount, c.perPhoto)
      const verdict = creditVerdict({ available: c.available, cost, photoCount: c.photoCount })
      const canStart = verdict !== 'insufficient'
      expect(canStart).toBe(cost <= c.available)
    }
  })
})
