// RD-LICENSE-COUPON-FIX — reusing vs superseding an unpaid license order.
//
// The bug: `POST /api/licensing/purchase` ran its existing-order reuse guard BEFORE
// coupon validation. An organizer who reached checkout once (leaving a `created`
// ₹2,499 order with a Razorpay order id) and then applied FREE2026 got the persisted
// full-price remainder back — the UI showed ₹0 while Razorpay was asked for ₹2,499.
//
// The reuse decision is now pure, so the scenarios can be asserted without Razorpay or
// Firestore. Scenarios that depend on gateway/paid state (D, E) are pinned at the source
// level below, because they live in the route and cannot be exercised without a gateway.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideCreatedOrderReuse } from '@/lib/licensing/existingOrderDecision'

const PRICE = 249_900   // ₹2,499 licence
const ROUTE = 'app/api/licensing/purchase/route.ts'
const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('A · existing unpaid ₹2,499 order + FREE2026 → supersede (→ ₹0, checkout null)', () => {
  it('supersedes when a coupon takes the price to zero', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: PRICE,
      persistedCouponCode:  null,
      requestedFinalPricePaise: 0,
      requestedCouponCode:  'FREE2026',
    })).toBe('supersede')
  })
})

describe('C · existing unpaid ₹2,499 order + same/no coupon → reuse', () => {
  it('reuses when nothing changed (no coupon either time)', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: PRICE,
      persistedCouponCode:  null,
      requestedFinalPricePaise: PRICE,
      requestedCouponCode:  null,
    })).toBe('reuse')
  })

  it('reuses when the SAME coupon resolves to the same price', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: 0,
      persistedCouponCode:  'FREE2026',
      requestedFinalPricePaise: 0,
      requestedCouponCode:  'FREE2026',
    })).toBe('reuse')
  })
})

describe('F · partial discount → stale amount must NOT be reused', () => {
  it('supersedes a full-price order when a partial coupon is applied', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: PRICE,
      persistedCouponCode:  null,
      requestedFinalPricePaise: 199_900,   // ₹500 off
      requestedCouponCode:  'SAVE500',
    })).toBe('supersede')
  })

  it('supersedes when the coupon is REMOVED and the price goes back up', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: 0,
      persistedCouponCode:  'FREE2026',
      requestedFinalPricePaise: PRICE,
      requestedCouponCode:  null,
    })).toBe('supersede')
  })

  it('supersedes when the coupon is SWAPPED even though the price is identical', () => {
    // Two codes can resolve to the same amount. The stored order must name the code that
    // will actually be redeemed — activateLicenseOrder increments currentUses on it.
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: 0,
      persistedCouponCode:  'FREE2026',
      requestedFinalPricePaise: 0,
      requestedCouponCode:  'FREEBIE',
    })).toBe('supersede')
  })

  it('supersedes on a tier price change with no coupon on either side', () => {
    expect(decideCreatedOrderReuse({
      persistedAmountPaise: PRICE,
      persistedCouponCode:  null,
      requestedFinalPricePaise: 299_900,
      requestedCouponCode:  null,
    })).toBe('supersede')
  })
})

// ── Route-level invariants: gateway/paid behaviour that cannot run without Razorpay ──
describe('route ordering and preserved protections', () => {
  const src = read(ROUTE)

  it('B · coupon validation runs BEFORE the existing-order guard', () => {
    const coupon = src.indexOf('validateLicenseCoupon(coupon, {')
    const guard  = src.indexOf('const existingOrderSnap =')
    expect(coupon).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(coupon).toBeLessThan(guard)
  })

  it('D · a captured payment is checked BEFORE superseding, and blocks it', () => {
    const supersedeBlock = src.slice(src.indexOf("if (decision === 'supersede')"))
    const captured = supersedeBlock.indexOf('findCapturedLicensePayment(existing.razorpayOrderId')
    const marker   = supersedeBlock.indexOf('supersededExisting = true')
    expect(captured).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(-1)
    expect(captured).toBeLessThan(marker)          // checked first
    expect(supersedeBlock).toMatch(/if \(captured\)/)
    expect(supersedeBlock).toMatch(/NOT superseding/)
  })

  it('E · the paid-order branch is unchanged (free retry / different-tier refusal)', () => {
    expect(src).toMatch(/if \(existing\?\.status === 'paid'\)/)
    expect(src).toMatch(/alreadyPaid: true/)
    expect(src).toMatch(/already_licensed/)
  })

  it('the GA-8 self-heal for captured-but-unconfirmed orders is retained', () => {
    expect(src).toMatch(/findCapturedLicensePayment\(existing\.razorpayOrderId, remainder\)/)
    expect(src).toMatch(/activateLicenseOrder\(/)
  })

  it('no Razorpay order is created when the remainder is zero', () => {
    const zero = src.indexOf('if (remainderPaise <= 0)')
    const mint = src.indexOf('await createLicenseRazorpayOrder(')
    expect(zero).toBeGreaterThan(-1)
    expect(mint).toBeGreaterThan(zero)             // minting is only in the >0 path
  })

  it('a superseded order is rewritten even with no coupon, so it cannot keep a stale order id', () => {
    expect(src).toMatch(/if \(couponFields \|\| supersededExisting\) await persistCreatedOrder\(null\)/)
  })

  it('the persisted order carries razorpayOrderId = null on the zero-remainder path', () => {
    expect(src).toMatch(/persistCreatedOrder\(null\)/)
    expect(src).toMatch(/razorpayOrderId,\s*$/m)   // written from the parameter, not hardcoded
  })
})
