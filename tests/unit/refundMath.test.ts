// MC-05 · Refund arithmetic. Pure — no Firestore, no emulator, no mocks.
//
// These assert the money rules the rest of the sprint depends on: a service charge can never
// exceed the purchase, a refund can never be negative, and rounding never favours the
// platform.

import { describe, it, expect } from 'vitest'
import {
  isWithinRefundWindow, refundAmountFor, refundBaseFor, serviceChargeFor,
} from '@/features/media-credits/utils/refundMath'

const percent = (p: number) => ({ method: 'percent' as const, percent: p, fixedPaise: 0 })
const fixed   = (f: number) => ({ method: 'fixed' as const,   percent: 0, fixedPaise: f })
const both    = (p: number, f: number) =>
  ({ method: 'percent_plus_fixed' as const, percent: p, fixedPaise: f })

describe('serviceChargeFor · percent', () => {
  it('takes the configured percentage', () => {
    expect(serviceChargeFor(10_000, percent(10)).amountPaise).toBe(1_000)
  })

  it('rounds DOWN, so a fraction of a paise goes to the organizer not the platform', () => {
    // 999 * 10% = 99.9 → 99, refund 900. Rounding up would quietly take the extra paise.
    expect(serviceChargeFor(999, percent(10)).amountPaise).toBe(99)
    expect(refundAmountFor(999, serviceChargeFor(999, percent(10)))).toBe(900)
  })

  it('0% keeps nothing and 100% keeps everything', () => {
    expect(serviceChargeFor(5_000, percent(0)).amountPaise).toBe(0)
    expect(serviceChargeFor(5_000, percent(100)).amountPaise).toBe(5_000)
  })

  it('clamps a percentage above 100 rather than inverting the refund', () => {
    expect(serviceChargeFor(5_000, percent(150)).amountPaise).toBe(5_000)
    expect(refundAmountFor(5_000, serviceChargeFor(5_000, percent(150)))).toBe(0)
  })

  it('records the policy it used, so the snapshot explains the number', () => {
    const c = serviceChargeFor(10_000, percent(10))
    expect(c).toMatchObject({ method: 'percent', percent: 10, fixedPaise: 0, amountPaise: 1_000 })
  })
})

describe('serviceChargeFor · fixed', () => {
  it('takes a flat fee regardless of amount', () => {
    expect(serviceChargeFor(10_000, fixed(500)).amountPaise).toBe(500)
    expect(serviceChargeFor(1_000,  fixed(500)).amountPaise).toBe(500)
  })

  it('never exceeds the purchase, so a small purchase refunds 0 rather than owing money', () => {
    expect(serviceChargeFor(300, fixed(500)).amountPaise).toBe(300)
    expect(refundAmountFor(300, serviceChargeFor(300, fixed(500)))).toBe(0)
  })
})

describe('serviceChargeFor · percent_plus_fixed', () => {
  it('applies both parts', () => {
    expect(serviceChargeFor(10_000, both(10, 500)).amountPaise).toBe(1_500)
  })

  it('clamps the combined charge to the purchase amount', () => {
    expect(serviceChargeFor(1_000, both(90, 500)).amountPaise).toBe(1_000)
    expect(refundAmountFor(1_000, serviceChargeFor(1_000, both(90, 500)))).toBe(0)
  })
})

describe('refundAmountFor', () => {
  it('is the purchase amount minus the charge', () => {
    expect(refundAmountFor(10_000, serviceChargeFor(10_000, percent(10)))).toBe(9_000)
  })

  it('is never negative', () => {
    expect(refundAmountFor(0, serviceChargeFor(0, fixed(500)))).toBe(0)
  })
})

describe('isWithinRefundWindow', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_700_000_000_000

  it('accepts a purchase inside the window', () => {
    expect(isWithinRefundWindow(now - 5 * DAY, now, 30)).toBe(true)
  })

  it('accepts one exactly on the boundary', () => {
    expect(isWithinRefundWindow(now - 30 * DAY, now, 30)).toBe(true)
  })

  it('rejects one past the window', () => {
    expect(isWithinRefundWindow(now - 31 * DAY, now, 30)).toBe(false)
  })

  it('FAILS CLOSED on a missing timestamp', () => {
    // A purchase whose grant time cannot be read must not be waved through: eligibility that
    // cannot be established is not eligibility.
    expect(isWithinRefundWindow(0, now, 30)).toBe(false)
  })

  it('a zero-day window admits nothing already in the past', () => {
    expect(isWithinRefundWindow(now - 1, now, 0)).toBe(false)
    expect(isWithinRefundWindow(now, now, 0)).toBe(true)
  })
})

// ─── RD-MC-REFUND-V2-P2 · the refund BASE ─────────────────────────────────────
//
// The base moved from "what the purchase cost" to "what its lot still holds, at that
// purchase's own price". These assert the two properties that makes safe: it is exact for an
// untouched purchase, and it never mixes one purchase's price with another's.

describe('refundBaseFor', () => {
  it("prices the REMAINDER at the purchase's own unit price", () => {
    // The brief's example: 500 bought at ₹1, one credit used, 499 refundable ⇒ ₹499.
    expect(refundBaseFor(499, 100)).toBe(49_900)
  })

  it('is EXACT for an untouched purchase — the pre-P2 amount, to the paise', () => {
    // `pricePack` computes amountPaise = credits × unit with no rounding, so a whole-purchase
    // refund prices identically before and after P2. This is what makes the switch a no-op
    // for every refund that could already be made.
    for (const [credits, unit] of [[500, 100], [2_000, 250], [1, 99], [5_000, 7]]) {
      expect(refundBaseFor(credits, unit)).toBe(credits * unit)
    }
  })

  it('NEVER mixes two purchases — each is priced at what was paid for it', () => {
    // 500 @ ₹1 and 500 @ ₹2, both with 300 unused. A wallet-wide average would return ₹450
    // for each; the organizer is owed ₹300 and ₹600.
    expect(refundBaseFor(300, 100)).toBe(30_000)
    expect(refundBaseFor(300, 200)).toBe(60_000)
  })

  it('ZERO remaining is worth zero — never the purchase amount', () => {
    expect(refundBaseFor(0, 100)).toBe(0)
  })

  it('ONE remaining credit still prices', () => {
    expect(refundBaseFor(1, 100)).toBe(100)
  })

  it('LARGE remainders do not lose precision', () => {
    // Integer paise throughout; nothing here goes near the float boundary.
    expect(refundBaseFor(100_000, 500)).toBe(50_000_000)
    expect(Number.isSafeInteger(refundBaseFor(100_000, 500))).toBe(true)
  })

  it('refuses to invent value from corrupt stored numbers', () => {
    // Negatives and fractions contribute ZERO rather than a negative or fractional refund.
    expect(refundBaseFor(-5, 100)).toBe(0)
    expect(refundBaseFor(499, -100)).toBe(0)
    expect(refundBaseFor(1.9, 100)).toBe(100)      // truncated, never rounded up
    expect(refundBaseFor(NaN, 100)).toBe(0)
    expect(refundBaseFor(499, NaN)).toBe(0)
  })
})

describe('the whole P2 chain: base → charge → payout', () => {
  it("reproduces the brief's worked example exactly", () => {
    // Purchased 500, used 1, remaining 499, ₹1 per credit, 10% service charge.
    const base = refundBaseFor(499, 100)
    const charge = serviceChargeFor(base, percent(10))
    const net = refundAmountFor(base, charge)

    expect(base).toBe(49_900)          // ₹499.00
    expect(charge.amountPaise).toBe(4_990)   // ₹49.90
    expect(net).toBe(44_910)           // ₹449.10
  })

  it('the charge is taken from the BASE, never the purchase amount', () => {
    // 500 bought (₹500), 100 left (₹100). Charging 10% of the purchase would take ₹50 from a
    // ₹100 refund — half of it — instead of ₹10.
    const base = refundBaseFor(100, 100)
    expect(serviceChargeFor(base, percent(10)).amountPaise).toBe(1_000)
    expect(refundAmountFor(base, serviceChargeFor(base, percent(10)))).toBe(9_000)
  })

  it('a FIXED charge larger than the remainder pays zero, never a bill', () => {
    // 1 credit left is ₹1; a ₹50 fixed charge cannot make the organizer owe ₹49.
    const base = refundBaseFor(1, 100)
    const charge = serviceChargeFor(base, fixed(5_000))
    expect(charge.amountPaise).toBe(100)     // clamped to the base
    expect(refundAmountFor(base, charge)).toBe(0)
  })

  it('a zero remainder pays zero through the whole chain', () => {
    const base = refundBaseFor(0, 100)
    expect(refundAmountFor(base, serviceChargeFor(base, both(10, 500)))).toBe(0)
  })
})
