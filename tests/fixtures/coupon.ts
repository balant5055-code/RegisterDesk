// RD-GA-HARDEN-01 — license-coupon fixtures.

import type { LicenseCouponDoc, LicenseCouponContext } from '@/lib/licensing/coupons/types'

export function couponDoc(over?: Partial<LicenseCouponDoc>): LicenseCouponDoc {
  return {
    code:              'SAVE10',
    description:        'Test coupon',
    type:              'percentage',
    value:             10,
    maxDiscountPaise:  null,
    minPurchasePaise:  null,
    maxPurchasePaise:  null,
    activatesAt:       null,
    expiresAt:         null,
    usageLimit:        null,
    perOrganizerLimit: null,
    currentUses:       0,
    restrictions:      { tiers: [], eventTypes: [] },
    enabled:           true,
    paused:            false,
    archived:          false,
    priority:          0,
    stackable:         false,
    visibility:        'public',
    campaign:          '',
    internalNotes:     '',
    version:           1,
    ...over,
  } as LicenseCouponDoc
}

export function couponCtx(over?: Partial<LicenseCouponContext>): LicenseCouponContext {
  return {
    tier:                 'professional',
    eventType:            null,
    pricePaise:           249900,
    organizerRedemptions: 0,
    couponsEnabled:       true,
    maxPercentageDiscount: 100,
    maxFixedDiscountPaise: 0,
    allowFreeLicense:     false,
    ...over,
  }
}
