// MC-07 · Purchase pack presentation. Pure — no React, no network.
//
// The property that matters: quantities are a UI choice, but every PRICE is derived from the
// server's unit price. A test that let a rupee figure be hardcoded would defeat the reason
// this logic was extracted at all.

import { describe, it, expect } from 'vitest'
import {
  CREDIT_PACKS, averageCostPerUpload, pricePack, recommendPack, remainingCapacity,
} from '@/features/media-credits/utils/creditPacks'

describe('pricePack', () => {
  it('prices from the SERVER unit price, never a constant', () => {
    const pack = { credits: 500 }
    expect(pricePack(pack, 100, 1).amountPaise).toBe(50_000)   // ₹1/credit
    expect(pricePack(pack, 250, 1).amountPaise).toBe(125_000)  // ₹2.50/credit
    // Change the admin's rate and every card moves with it.
  })

  it('truncates, matching pricingService.quote', () => {
    // The card's figure and the purchase intent's charge must not differ by a paisa.
    expect(pricePack({ credits: 10.9 }, 100, 1).amountPaise).toBe(1_000)
    expect(pricePack({ credits: 10 }, 100.9, 1).amountPaise).toBe(1_000)
  })

  it('reports photos covered at the current rate', () => {
    expect(pricePack({ credits: 500 }, 100, 1).photosCovered).toBe(500)
    expect(pricePack({ credits: 500 }, 100, 2).photosCovered).toBe(250)
  })

  it('says nothing rather than Infinity when the rate is unusable', () => {
    expect(pricePack({ credits: 500 }, 100, 0).photosCovered).toBeNull()
  })

  it('never produces a negative amount', () => {
    expect(pricePack({ credits: -5 }, 100, 1).amountPaise).toBe(0)
    expect(pricePack({ credits: 5 }, -100, 1).amountPaise).toBe(0)
  })

  it('the offered packs carry no baked-in price', () => {
    // Each pack is a quantity and an optional badge — nothing money-shaped.
    for (const pack of CREDIT_PACKS) {
      expect(Object.keys(pack).sort()).not.toContain('amountPaise')
      expect(Object.keys(pack).sort()).not.toContain('price')
      expect(pack.credits).toBeGreaterThan(0)
    }
  })

  it('exactly one pack is recommended', () => {
    expect(CREDIT_PACKS.filter(p => p.recommended)).toHaveLength(1)
  })
})

describe('remainingCapacity', () => {
  it('converts credits into photos at the current rate', () => {
    expect(remainingCapacity(1000, 1)).toBe(1000)
    expect(remainingCapacity(1000, 2)).toBe(500)
  })

  it('floors — a partial photo is not a photo', () => {
    expect(remainingCapacity(999, 2)).toBe(499)
  })

  it('is null when the rate is unusable, never Infinity', () => {
    expect(remainingCapacity(1000, 0)).toBeNull()
  })

  it('never reports negative capacity', () => {
    expect(remainingCapacity(-50, 1)).toBe(0)
  })
})

describe('recommendPack', () => {
  it('suggests the smallest pack that clears the shortfall', () => {
    expect(recommendPack(100)?.credits).toBe(500)
    expect(recommendPack(1_500)?.credits).toBe(2_000)
  })

  it('falls back to the largest when none is big enough', () => {
    // Recommending nothing would leave an organizer with no next step.
    expect(recommendPack(1_000_000)?.credits).toBe(5_000)
  })

  it('returns null only when there are no packs at all', () => {
    expect(recommendPack(100, [])).toBeNull()
  })
})

describe('averageCostPerUpload', () => {
  it('divides lifetime credits by photos actually uploaded', () => {
    expect(averageCostPerUpload(500, 500)).toBe(1)
    expect(averageCostPerUpload(1000, 500)).toBe(2)
  })

  it('is null when the photo count is unknown', () => {
    // The count is null when the aggregation failed. Dividing by an unknown and showing a
    // confident average would be worse than showing a dash.
    expect(averageCostPerUpload(500, null)).toBeNull()
  })

  it('is null when nothing has been uploaded — never a divide by zero', () => {
    expect(averageCostPerUpload(0, 0)).toBeNull()
  })
})
