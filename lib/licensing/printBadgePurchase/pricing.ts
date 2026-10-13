// RD-PRINT-BILL-P4 · Prepaid ID-badge unit purchases — the PURE pricing, tax-treatment and order
// snapshot rules. Client-safe: no Firebase / SDK import.
//
// ═══ WHAT AN ORDER FREEZES ════════════════════════════════════════════════════
// A badge purchase order (`licenseOrders/bdg_…`, purpose 'print_badges') carries ONE immutable
// `badgePurchase` snapshot, fixed when the order is created and never rewritten:
//   quantity × unitPricePaise           = grossPaise   (GST-INCLUSIVE — SERVICE_PRICE_MODE 'inclusive')
//   grossPaise − coupon discount        = netPaise     (what is charged; the Razorpay amount)
//   netPaise split by the APPROVED tax treatment (below) into netBasePaise + netGstPaise.
// Integer paise throughout. Nothing is ever re-priced from configuration after creation: a later
// price, rate or coupon edit changes FUTURE quotes only.
//
// ═══ TAX TREATMENT (what the accountant approves) ═════════════════════════════
// The rule set is a CODE constant with an id. The recorded GST approval
// (lib/licensing/printBadgePurchase/taxApproval.ts) names the rate AND this id + basis; changing
// either here or the configured rate invalidates the approval until it is recorded again.

import { inclusiveTaxablePaise } from '../serviceAllowances'
import type { BadgeCouponSnapshot } from '../badgeCoupons/types'

export const BADGE_ORDER_PREFIX = 'bdg_'
export const BADGE_ORDER_PURPOSE = 'print_badges' as const

/** Approved 2026-10-10: at least 100 badges per purchase; hard ceiling 100,000 per order. */
export const BADGE_PURCHASE_MIN_UNITS = 100
export const BADGE_PURCHASE_MAX_UNITS = 100_000

/** A checkout is handed out for 30 minutes from creation. */
export const BADGE_ORDER_TTL_MS = 30 * 60_000
/**
 * The reconciliation grace after expiry. A capture that lands while the order is still `created`
 * (UPI approvals can trail the checkout by minutes) is settled normally. Only once `expiresAt + GRACE`
 * has passed AND Razorpay confirms nothing was captured does the sweep mark the order `expired`;
 * any capture after that is HELD for review (never activated).
 */
export const BADGE_ORDER_GRACE_MS = 30 * 60_000
/** An existing checkout is only handed out again while at least this much of its window remains. */
export const BADGE_CHECKOUT_REUSE_MARGIN_MS = 5 * 60_000
/** Razorpay's minimum order amount (₹1). A paid net between 1 and 99 paise cannot be charged. */
export const GATEWAY_MIN_PAISE = 100

/** Published events only: a live event that is not cancelled, completed or archived. */
export const BADGE_PURCHASE_LIFECYCLES = ['published', 'registration_closed'] as const
export function isBadgePurchaseLifecycle(status: unknown): boolean {
  return (BADGE_PURCHASE_LIFECYCLES as readonly string[]).includes(String(status))
}

/** The client's idempotency key for one purchase attempt. */
export const BADGE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

// ─── Tax treatment ────────────────────────────────────────────────────────────

export interface BadgeTaxTreatment {
  id:                string
  priceMode:         'inclusive'
  discountTreatment: string
  roundingMethod:    string
  scope:             string
}

/**
 * The ONE tax treatment badge purchases use (id 'badge-inclusive-v1'). Changing ANY field is a new
 * treatment: give it a new id — every recorded approval then stops matching until re-approved.
 */
export const BADGE_TAX_TREATMENT: Readonly<BadgeTaxTreatment> = Object.freeze({
  id:                'badge-inclusive-v1',
  priceMode:         'inclusive',
  discountTreatment: 'A coupon discount reduces the GST-inclusive consideration BEFORE tax is extracted: GST is computed only on the net amount actually charged.',
  roundingMethod:    'Per order, integer paise: taxable base = Math.round(net × 100 ÷ (100 + rate)) (half-up); GST = net − taxable base.',
  scope:             'One tax computation per order on its net total; never per unit, never re-added on top of the inclusive price.',
})

export function sameTaxTreatment(a: unknown, b: Readonly<BadgeTaxTreatment> = BADGE_TAX_TREATMENT): boolean {
  if (!a || typeof a !== 'object') return false
  const x = a as Record<string, unknown>
  return x.id === b.id && x.priceMode === b.priceMode && x.discountTreatment === b.discountTreatment
    && x.roundingMethod === b.roundingMethod && x.scope === b.scope
}

/** Pure: split a GST-inclusive net into taxable base + GST under badge-inclusive-v1. */
export function splitInclusiveNet(netPaise: number, gstRatePercent: number): { basePaise: number; gstPaise: number } {
  if (netPaise === 0) return { basePaise: 0, gstPaise: 0 }
  const basePaise = inclusiveTaxablePaise(netPaise, gstRatePercent)
  return { basePaise, gstPaise: netPaise - basePaise }
}

export const isValidGstRate = (r: unknown): r is number =>
  typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 100

/** The recorded GST approval as stored (platformApprovals/print_badges_gst) — see taxApproval.ts. */
export interface BadgeTaxApprovalRecord {
  status:              'approved' | 'revoked'
  approvalId:          string
  gstRatePercent:      number
  taxTreatment:        BadgeTaxTreatment
  /** As SUPPLIED by the Super Admin recording it — the accountant's name/firm and their reference. */
  accountantName:      string
  accountantReference: string
  accountantApprovedOn: string | null
  /** Who RECORDED the approval in RegisterDesk (a Super Admin uid) — never presented as the accountant. */
  recordedByUid:       string
  reason:              string
  version:             number
}

export type BadgeTaxApprovalProblem = 'GST_NOT_CONFIGURED' | 'TAX_NOT_APPROVED' | 'TAX_APPROVAL_MISMATCH'

/**
 * Pure. Paid quotes fail CLOSED unless a GST rate is configured AND an approval is recorded for
 * exactly that rate and exactly the current tax treatment. Never assumes a rate.
 */
export function badgeTaxApprovalProblem(approval: unknown, configuredGstRate: number | null): BadgeTaxApprovalProblem | null {
  if (!isValidGstRate(configuredGstRate)) return 'GST_NOT_CONFIGURED'
  if (!approval || typeof approval !== 'object') return 'TAX_NOT_APPROVED'
  const a = approval as Partial<BadgeTaxApprovalRecord>
  if (a.status !== 'approved' || typeof a.approvalId !== 'string' || !a.approvalId) return 'TAX_NOT_APPROVED'
  if (a.gstRatePercent !== configuredGstRate || !sameTaxTreatment(a.taxTreatment)) return 'TAX_APPROVAL_MISMATCH'
  return null
}

// ─── The snapshot ─────────────────────────────────────────────────────────────

export interface BadgeOrderCoupon {
  code:          string
  discountPaise: number
  snapshot:      BadgeCouponSnapshot
  /** The financial terms the discount was computed from (compared again at settlement). */
  minPurchasePaise: number | null
}

export interface BadgePurchaseSnapshot {
  quantity:        number
  unitPricePaise:  number
  priceSource:     'global' | 'event'
  /** Business Configuration version the global price/rate were read at (null if unknown). */
  configVersion:   number | null
  grossPaise:      number
  coupon:          BadgeOrderCoupon | null
  discountPaise:   number
  netPaise:        number
  gstRatePercent:  number
  netBasePaise:    number
  netGstPaise:     number
  taxTreatment:    BadgeTaxTreatment
  /** The approval the rate was charged under (taxApproval.ts) — reference only, never an identity. */
  taxApprovalId:   string
  currency:        'INR'
  onExhausted:     'block'
}

export type BadgeQuoteRefusal =
  | 'QUANTITY_INVALID' | 'PRICE_NOT_CONFIGURED' | 'AMOUNT_BELOW_GATEWAY_MIN' | 'DISCOUNT_INVALID'

export function quantityBounds(cfg: { minQuantity?: number | null; maxQuantity?: number | null }): { min: number; max: number } {
  const min = Math.max(BADGE_PURCHASE_MIN_UNITS, Number.isInteger(cfg.minQuantity) && (cfg.minQuantity as number) > 0 ? cfg.minQuantity as number : 0)
  const max = Math.min(BADGE_PURCHASE_MAX_UNITS, Number.isInteger(cfg.maxQuantity) && (cfg.maxQuantity as number) > 0 ? cfg.maxQuantity as number : BADGE_PURCHASE_MAX_UNITS)
  return { min, max }
}

/**
 * Pure. Builds the immutable snapshot, or refuses. `coupon` is the ALREADY-VALIDATED coupon result
 * (validateBadgeCoupon on the gross) — this function only applies it.
 */
export function buildBadgeSnapshot(input: {
  quantity:       number
  unitPricePaise: number | null
  priceSource:    'global' | 'event'
  configVersion:  number | null
  gstRatePercent: number | null
  bounds:         { min: number; max: number }
  coupon:         BadgeOrderCoupon | null
  taxApprovalId:  string
}): { ok: true; snapshot: BadgePurchaseSnapshot } | { ok: false; code: BadgeQuoteRefusal; message: string } {
  const { quantity, unitPricePaise: unit, gstRatePercent: rate, bounds } = input
  if (!Number.isInteger(quantity) || quantity < bounds.min || quantity > bounds.max) {
    return { ok: false, code: 'QUANTITY_INVALID', message: `Choose between ${bounds.min.toLocaleString('en-IN')} and ${bounds.max.toLocaleString('en-IN')} badges.` }
  }
  if (!(typeof unit === 'number' && Number.isInteger(unit) && unit > 0) || !isValidGstRate(rate)) {
    return { ok: false, code: 'PRICE_NOT_CONFIGURED', message: 'Badge pricing is not configured yet.' }
  }
  const grossPaise = quantity * unit
  const discountPaise = input.coupon ? input.coupon.discountPaise : 0
  if (!Number.isInteger(discountPaise) || discountPaise < 0 || discountPaise > grossPaise || (input.coupon !== null && discountPaise === 0)) {
    return { ok: false, code: 'DISCOUNT_INVALID', message: 'This coupon cannot be applied to this purchase.' }
  }
  const netPaise = grossPaise - discountPaise
  if (netPaise > 0 && netPaise < GATEWAY_MIN_PAISE) {
    return { ok: false, code: 'AMOUNT_BELOW_GATEWAY_MIN', message: 'The amount after the discount is below ₹1, which cannot be charged. Buy more badges or remove the coupon.' }
  }
  const { basePaise, gstPaise } = splitInclusiveNet(netPaise, rate)
  return {
    ok: true,
    snapshot: {
      quantity, unitPricePaise: unit, priceSource: input.priceSource, configVersion: input.configVersion,
      grossPaise, coupon: input.coupon, discountPaise, netPaise,
      gstRatePercent: rate, netBasePaise: basePaise, netGstPaise: gstPaise,
      taxTreatment: { ...BADGE_TAX_TREATMENT }, taxApprovalId: input.taxApprovalId,
      currency: 'INR', onExhausted: 'block',
    },
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Pure. Is a STORED snapshot internally consistent (every figure re-derivable from the others)? */
export function isConsistentBadgeSnapshot(s: unknown): s is BadgePurchaseSnapshot {
  if (!s || typeof s !== 'object') return false
  const x = s as BadgePurchaseSnapshot
  if (!isInt(x.quantity) || x.quantity < BADGE_PURCHASE_MIN_UNITS || x.quantity > BADGE_PURCHASE_MAX_UNITS) return false
  if (!isInt(x.unitPricePaise) || x.unitPricePaise <= 0 || !isValidGstRate(x.gstRatePercent)) return false
  if (x.currency !== 'INR' || !sameTaxTreatment(x.taxTreatment) || typeof x.taxApprovalId !== 'string' || !x.taxApprovalId) return false
  if (x.grossPaise !== x.quantity * x.unitPricePaise) return false
  const couponDiscount = x.coupon ? x.coupon.discountPaise : 0
  if (!isInt(x.discountPaise) || x.discountPaise !== couponDiscount || x.discountPaise < 0 || x.discountPaise > x.grossPaise) return false
  if (x.coupon && (x.discountPaise === 0 || typeof x.coupon.code !== 'string' || !x.coupon.snapshot || x.coupon.snapshot.code !== x.coupon.code)) return false
  if (x.netPaise !== x.grossPaise - x.discountPaise) return false
  if (x.netPaise > 0 && x.netPaise < GATEWAY_MIN_PAISE) return false
  const split = splitInclusiveNet(x.netPaise, x.gstRatePercent)
  return x.netBasePaise === split.basePaise && x.netGstPaise === split.gstPaise
}

/**
 * Pure. Does a coupon validation made NOW still match what the order bound? The discount and every
 * financial term must be identical; the coupon VERSION may differ (a description-only edit bumps
 * it) — any change that matters is a change in type, value, cap, minimum or the resulting discount.
 */
export function couponStillMatches(bound: BadgeOrderCoupon, now: {
  discountPaise: number; finalPricePaise: number; snapshot: BadgeCouponSnapshot; minPurchasePaise: number | null
}, netPaise: number): boolean {
  return now.discountPaise === bound.discountPaise && now.finalPricePaise === netPaise
    && now.snapshot.code === bound.snapshot.code && now.snapshot.scope === bound.snapshot.scope
    && now.snapshot.type === bound.snapshot.type && now.snapshot.value === bound.snapshot.value
    && (now.snapshot.maxDiscountPaise ?? null) === (bound.snapshot.maxDiscountPaise ?? null)
    && (now.minPurchasePaise ?? null) === (bound.minPurchasePaise ?? null)
}
