// RD-GA-HARDEN-01 — license coupon validation + discount math (coupons/validate.ts).

import { describe, it, expect } from 'vitest'
import { validateLicenseCoupon, deriveCouponLifecycle } from '@/lib/licensing/coupons/validate'
import { couponDoc, couponCtx } from '../fixtures/coupon'

const NOW = Date.parse('2026-07-21T00:00:00.000Z')

describe('discount computation (integer paise)', () => {
  it('percentage discount, clamped by the business-config cap', () => {
    const r = validateLicenseCoupon(couponDoc({ type: 'percentage', value: 10 }), couponCtx({ pricePaise: 249900 }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.discountPaise).toBe(24990); expect(r.finalPricePaise).toBe(224910) }
  })

  it('percentage is clamped to maxDiscountPaise', () => {
    const r = validateLicenseCoupon(couponDoc({ type: 'percentage', value: 50, maxDiscountPaise: 10000 }), couponCtx({ pricePaise: 249900 }), NOW)
    expect(r.ok && r.discountPaise).toBe(10000)
  })

  it('fixed discount cannot exceed the price', () => {
    const r = validateLicenseCoupon(couponDoc({ type: 'fixed', value: 999900 }), couponCtx({ pricePaise: 99900 }), NOW)
    expect(r.ok && r.discountPaise).toBe(99900)
    expect(r.ok && r.finalPricePaise).toBe(0)
  })

  it('free coupon requires allowFreeLicense', () => {
    expect(validateLicenseCoupon(couponDoc({ type: 'free' }), couponCtx({ allowFreeLicense: false }), NOW).ok).toBe(false)
    const ok = validateLicenseCoupon(couponDoc({ type: 'free' }), couponCtx({ allowFreeLicense: true, pricePaise: 249900 }), NOW)
    expect(ok.ok && ok.discountPaise).toBe(249900)
  })
})

describe('lifecycle + eligibility gates', () => {
  it('deriveCouponLifecycle reflects flags/dates', () => {
    expect(deriveCouponLifecycle(couponDoc({ archived: true }), NOW)).toBe('archived')
    expect(deriveCouponLifecycle(couponDoc({ paused: true }), NOW)).toBe('paused')
    expect(deriveCouponLifecycle(couponDoc({ expiresAt: '2020-01-01T00:00:00Z' }), NOW)).toBe('expired')
    expect(deriveCouponLifecycle(couponDoc({ enabled: false }), NOW)).toBe('draft')
    expect(deriveCouponLifecycle(couponDoc({ activatesAt: '2999-01-01T00:00:00Z' }), NOW)).toBe('scheduled')
    expect(deriveCouponLifecycle(couponDoc(), NOW)).toBe('active')
  })

  it('rejects when coupons disabled, not found, expired, or usage-capped', () => {
    expect(validateLicenseCoupon(couponDoc(), couponCtx({ couponsEnabled: false }), NOW).ok).toBe(false)
    expect(validateLicenseCoupon(null, couponCtx(), NOW).ok).toBe(false)
    expect(validateLicenseCoupon(couponDoc({ expiresAt: '2020-01-01T00:00:00Z' }), couponCtx(), NOW).ok).toBe(false)
    expect(validateLicenseCoupon(couponDoc({ usageLimit: 5, currentUses: 5 }), couponCtx(), NOW).ok).toBe(false)
    expect(validateLicenseCoupon(couponDoc({ perOrganizerLimit: 1 }), couponCtx({ organizerRedemptions: 1 }), NOW).ok).toBe(false)
  })

  it('enforces tier + purchase-bound restrictions', () => {
    expect(validateLicenseCoupon(couponDoc({ restrictions: { tiers: ['enterprise'], eventTypes: [] } }), couponCtx({ tier: 'professional' }), NOW).ok).toBe(false)
    expect(validateLicenseCoupon(couponDoc({ minPurchasePaise: 500000 }), couponCtx({ pricePaise: 249900 }), NOW).ok).toBe(false)
  })
})
