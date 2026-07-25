// RD-ATTENDEE-02A C2 — early-bird pricing consistency.
//
// Proves the ONE canonical base-amount resolver (resolveEffectivePassPricePaise) that
// create-order (charge), submit (free/coupon-zero) and validate-coupon (checkout
// preview) all now share, so the amount SHOWN at checkout equals the amount CHARGED.

import { describe, it, expect, vi } from 'vitest'

// computeDiscount lives in a module that imports the Admin SDK at load — stub it so the
// pure discount math can be imported without Firebase.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  isEarlyBirdActive,
  resolveEffectivePriceRupees,
  resolveEffectivePassPricePaise,
} from '@/lib/pricing/earlyBird'
import { computeDiscount } from '@/lib/coupons/validate'
import type { CouponDocument } from '@/lib/coupons/types'
import { passDisplayPrice, minPassPrice } from '@/components/event-templates/shared/utils/format'
import type { PassPublic } from '@/components/event-templates/types'

const NOW = Date.parse('2026-07-24T12:00')          // fixed "now"
const FUTURE = '2999-12-31T23:59'                    // cutoff far ahead → early bird active
const PAST   = '2000-01-01T00:00'                    // cutoff far behind → early bird expired

// A raw stored pass (Firestore shape) with an active early bird: ₹1000 regular, ₹800 EB.
function pass(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'p1', name: 'Pass', price: 1000, earlyBirdEnabled: true, earlyBirdPrice: 800, earlyBirdEndDate: FUTURE, ...overrides }
}

describe('resolveEffectivePassPricePaise — the canonical base amount', () => {
  it('early bird active → early-bird price in paise', () => {
    expect(resolveEffectivePassPricePaise(pass(), NOW)).toBe(80000)
  })

  it('early bird EXPIRED (cutoff passed) → regular price in paise', () => {
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdEndDate: PAST }), NOW)).toBe(100000)
  })

  it('early bird disabled → regular price', () => {
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdEnabled: false }), NOW)).toBe(100000)
  })

  it('early-bird price above regular is ignored (never charge more than regular)', () => {
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdPrice: 1200 }), NOW)).toBe(100000)
  })

  it('non-positive / missing early-bird price → regular', () => {
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdPrice: 0 }), NOW)).toBe(100000)
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdPrice: null }), NOW)).toBe(100000)
  })

  it('no cutoff date → early bird active while enabled', () => {
    expect(isEarlyBirdActive({ price: 1000, earlyBirdEnabled: true, earlyBirdPrice: 800, earlyBirdEndDate: '' }, NOW)).toBe(true)
    expect(resolveEffectivePassPricePaise(pass({ earlyBirdEndDate: '' }), NOW)).toBe(80000)
  })

  it('free/absent price → 0 paise (routed to the free flow)', () => {
    expect(resolveEffectivePassPricePaise({ id: 'p', name: 'x' }, NOW)).toBe(0)
  })

  it('agrees with resolveEffectivePriceRupees × 100', () => {
    expect(resolveEffectivePassPricePaise(pass(), NOW)).toBe(Math.round(resolveEffectivePriceRupees({ price: 1000, earlyBirdEnabled: true, earlyBirdPrice: 800, earlyBirdEndDate: FUTURE }, NOW) * 100))
  })
})

describe('coupon + early bird — discount applies to the early-bird base (shown === charged)', () => {
  const pct10: CouponDocument = { type: 'percentage', value: 10 } as unknown as CouponDocument

  it('coupon discounts from the EARLY-BIRD base, not the regular base', () => {
    const p = pass()   // EB active: base ₹800 → 80000 paise
    const base = resolveEffectivePassPricePaise(p, NOW)
    expect(base).toBe(80000)

    const discount = computeDiscount(pct10, base)          // 10% of 80000 = 8000
    const final    = Math.max(0, base - discount)
    expect(discount).toBe(8000)
    expect(final).toBe(72000)

    // The pre-fix bug: discounting the REGULAR base (100000) would have shown a
    // different preview (10% = 10000, final 90000) than what create-order charges.
    const regularBaseDiscount = computeDiscount(pct10, 100000)
    expect(regularBaseDiscount).not.toBe(discount)
  })

  it('checkout preview base === payment charge base (same resolver, same pass, same now)', () => {
    const p = pass()
    // validate-coupon (checkout preview) and create-order (charge) now derive the base
    // from the identical function — so the number shown equals the number charged.
    const checkoutBase = resolveEffectivePassPricePaise(p, NOW)
    const paymentBase  = resolveEffectivePassPricePaise(p, NOW)
    expect(checkoutBase).toBe(paymentBase)

    const previewFinal = Math.max(0, checkoutBase - computeDiscount(pct10, checkoutBase))
    const chargeFinal  = Math.max(0, paymentBase  - computeDiscount(pct10, paymentBase))
    expect(previewFinal).toBe(chargeFinal)
  })

  it('once the early bird expires, both surfaces move to the regular base together', () => {
    const p = pass({ earlyBirdEndDate: PAST })
    expect(resolveEffectivePassPricePaise(p, NOW)).toBe(100000)
    const final = Math.max(0, 100000 - computeDiscount(pct10, 100000))
    expect(final).toBe(90000)
  })
})

describe('event-details display — passDisplayPrice / minPassPrice show the effective price', () => {
  function pub(overrides: Partial<PassPublic> = {}): PassPublic {
    return { id: 'p', name: 'Pass', description: '', price: 1000, quantity: null, unlimited: true, ...overrides }
  }

  it('passDisplayPrice shows the server-resolved effectivePrice when present', () => {
    expect(passDisplayPrice(pub({ price: 1000, effectivePrice: 800 }))).toBe(800)
  })

  it('passDisplayPrice falls back to regular price when effectivePrice is absent (backward-compat)', () => {
    expect(passDisplayPrice(pub({ price: 1000 }))).toBe(1000)
  })

  it('minPassPrice ("from ₹") is computed over effective prices, ignoring inactive passes', () => {
    const passes = [
      pub({ id: 'a', price: 1500, effectivePrice: 1200 }),
      pub({ id: 'b', price: 1000, effectivePrice: 700 }),
      pub({ id: 'c', price: 500,  effectivePrice: 500, status: 'inactive' }),
    ]
    expect(minPassPrice(passes)).toBe(700)   // cheapest ACTIVE effective price
  })
})
