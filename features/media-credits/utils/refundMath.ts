// MC-05 · Refund arithmetic — PURE. No Firestore, no config read, no I/O.
//
// Split out for the same reason `ledgerMath.ts` was: the money decisions become testable in
// the default `node` vitest env, with no emulator and no mocks. Anything here that is wrong
// is wrong in a way a unit test can catch.
//
// ═══ EVERY AMOUNT IS INTEGER PAISE ═══════════════════════════════════════════
// No floats survive a function boundary. A percentage is computed as
// `Math.floor(amount * percent / 100)`, and flooring is deliberate: it rounds the service
// charge DOWN, which rounds the organizer's refund UP. A half-paise should not accrue to
// the platform.

import type { ServiceChargeMethod, ServiceChargeSnapshot } from '@/features/media-credits/types'

export interface ServiceChargePolicy {
  method:     ServiceChargeMethod
  percent:    number
  fixedPaise: number
}

/**
 * Computes the service charge for a purchase amount.
 *
 * Clamped to the purchase amount: a fixed fee larger than the purchase, or a
 * `percent_plus_fixed` that overshoots, must never produce a negative refund. The organizer
 * gets zero back in that case — never a bill.
 */
export function serviceChargeFor(
  purchaseAmountPaise: number,
  policy: ServiceChargePolicy,
): ServiceChargeSnapshot {
  const base    = Math.max(0, Math.trunc(purchaseAmountPaise))
  const percent = Math.min(100, Math.max(0, Math.trunc(policy.percent)))
  const fixed   = Math.max(0, Math.trunc(policy.fixedPaise))

  const fromPercent = Math.floor((base * percent) / 100)

  let amountPaise: number
  switch (policy.method) {
    case 'percent':            amountPaise = fromPercent;         break
    case 'fixed':              amountPaise = fixed;               break
    case 'percent_plus_fixed': amountPaise = fromPercent + fixed; break
  }

  return {
    method:      policy.method,
    percent,
    fixedPaise:  fixed,
    amountPaise: Math.min(base, amountPaise),   // never exceeds what was paid
  }
}

/**
 * RD-MC-REFUND-V2-P2 · What a refund is calculated ON.
 *
 * ═══ THE BASE IS UNUSED CREDITS, NOT THE PURCHASE AMOUNT ═════════════════════
 * Before P2 a refund covered a whole untouched purchase, so the base WAS the purchase amount.
 * Now it is whatever the purchase's lot still holds, priced at that purchase's OWN unit price.
 *
 * Using the purchase's own `unitPricePaise` is what keeps two purchases from contaminating
 * each other: 500 credits bought at ₹1 and 500 bought at ₹2 refund at ₹1 and ₹2 respectively,
 * however they were interleaved in the wallet. A wallet-wide average price would be indefensible
 * — the organizer paid two different prices and is owed each of them.
 *
 * Exact for the whole-purchase case, not merely close: `pricePack` computes
 * `amountPaise = credits × unitPricePaise` with no rounding, so when a lot is untouched this
 * returns the purchase amount identically. Every refund that could be made before P2 prices
 * to the same paise after it.
 */
export function refundBaseFor(
  creditsRemaining: number, unitPricePaise: number,
): number {
  // `safe`, not `Math.max(0, Math.trunc(x))` — the latter returns NaN for NaN, and a NaN base
  // survives `serviceChargeFor` and `refundAmountFor` unchanged. The refund would then be
  // written to Firestore as NaN and the organizer told they are owed nothing readable.
  // A stored number that cannot be trusted is worth zero, and zero fails visibly.
  return safe(creditsRemaining) * safe(unitPricePaise)
}

/** A stored number that cannot be trusted contributes 0 rather than NaN to the arithmetic. */
function safe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0
}

/** What the organizer actually receives. Never negative, by construction. */
export function refundAmountFor(
  purchaseAmountPaise: number,
  charge: ServiceChargeSnapshot,
): number {
  return Math.max(0, Math.trunc(purchaseAmountPaise) - charge.amountPaise)
}

/**
 * Is a purchase still inside its refund window?
 *
 * `purchasedAtMs === 0` means the timestamp is missing or unreadable, which is treated as
 * OUTSIDE the window — fail closed. A refund whose eligibility cannot be established should
 * be refused and looked at by a human, not waved through.
 */
export function isWithinRefundWindow(
  purchasedAtMs: number, nowMs: number, windowDays: number,
): boolean {
  if (!purchasedAtMs) return false
  const windowMs = Math.max(0, Math.trunc(windowDays)) * 24 * 60 * 60 * 1000
  return nowMs - purchasedAtMs <= windowMs
}
