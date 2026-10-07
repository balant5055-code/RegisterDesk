// RD-CE-FIX H4 · settle an earlier, possibly-paid ACTIVATION checkout before anything decides the
// event needs no payment. SERVER-ONLY.
//
// The audit traced: checkout started (lic_{draftId} 'created' with a Razorpay order) → organizer lowers
// capacity to the free allowance → purchase answers "₹0" (its shortcut ran BEFORE the GA-8 self-heal)
// → publish (no payment required) → the old checkout is paid afterwards → webhook/confirm activate
// lic_ after publish: money captured, service units granted, capacity never applied to the event.
//
// The deterministic rule, using only the existing mechanisms:
//   • purchase and publish call settleCapturedActivation() first. A CAPTURED payment on the pending
//     order is activated now (the organizer paid; they get what they paid for — and publish then
//     refuses to drop capacity below it, see draftCoverage / M3). An UNKNOWN status changes nothing
//     and the caller asks for a retry. An authorised-not-captured payment is "unknown" (money in flight).
//   • publish then SUPERSEDES a pending order it does not use (archive `lic_{d}__sup_{rzp}`, status
//     failed/superseded — the same F2A shape purchase writes). A payment captured on it later is found
//     by the webhook / confirm and HELD for Super Admin review (manualRefundHold) — never granted,
//     never auto-refunded.

import { adminDb } from '@/lib/firebase/admin'
import { razorpay } from '@/lib/razorpay/client'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter, type LicenseOrderDoc } from './schema'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion } from './eventLicense'
import { getEffectiveDefinitionForVersion } from './resolveCatalog'
import { activateLicenseOrder, holdExhaustedCouponRemainder, holdPhotoCapacityExceeded, orderListPricePaise } from './finalizeLicensePurchase'
import { scheduleServicePurchaseNotification } from '@/lib/notifications/servicePurchase'

/**
 * GA-8 P1-1 / RD-M3 — find a captured/authorized Razorpay payment on an existing licence order that
 * matches the persisted remainder (amount + INR). THREE states, never two: a lookup that fails or
 * returns something unusable is 'unknown'. 'captured' carries the real status: `authorized` is money
 * in flight (it blocks replacement) but never self-heals an activation.
 */
export type CaptureLookup =
  | { state: 'captured'; paymentId: string; paymentStatus: 'captured' | 'authorized' }
  | { state: 'none' }
  | { state: 'unknown' }

export async function findCapturedLicensePayment(razorpayOrderId: string, expectedRemainderPaise: number): Promise<CaptureLookup> {
  if (expectedRemainderPaise <= 0) return { state: 'none' }
  try {
    const res = await razorpay.orders.fetchPayments(razorpayOrderId) as { items?: unknown } | null | undefined
    if (!res || !Array.isArray(res.items)) {
      console.error('[license] fetchPayments returned an unusable response — capture status UNKNOWN', { razorpayOrderId })
      return { state: 'unknown' }
    }
    const items = res.items as Array<{ id?: unknown; status?: unknown; amount?: unknown; currency?: unknown } | null>
    const matches = (s: string) => items.find(p => !!p && p.status === s && p.currency === 'INR' && p.amount === expectedRemainderPaise)
    const hit = matches('captured') ?? matches('authorized')
    if (!hit) return { state: 'none' }
    if (typeof hit.id !== 'string' || !hit.id) return { state: 'unknown' }
    return { state: 'captured', paymentId: hit.id, paymentStatus: hit.status === 'captured' ? 'captured' : 'authorized' }
  } catch (err) {
    console.error('[license] fetchPayments failed — capture status UNKNOWN', { razorpayOrderId, error: err instanceof Error ? err.message : 'error' })
    return { state: 'unknown' }
  }
}

export type SettleOutcome =
  | 'no_pending'   // no `created` activation order with a Razorpay order — nothing to settle
  | 'unpaid'       // a pending order exists and nothing was captured on it
  | 'activated'    // a captured payment was found and the order is now paid (or already was)
  | 'held'         // captured, but could not be applied (coupon exhausted) — recorded as a hold
  | 'unapplied'    // captured, but not activatable (underpaid / ineligible) — left for review
  | 'unknown'      // status could not be established, or money is authorised-not-captured

/** Settles `lic_{draftId}` when it is a pending checkout that may already have been paid. */
export async function settleCapturedActivation(draftId: string, organizerUid: string): Promise<SettleOutcome> {
  const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`).withConverter(licenseOrderConverter).get()
  const existing: LicenseOrderDoc | undefined = snap.exists ? snap.data() : undefined
  if (!existing || existing.status !== 'created' || !existing.razorpayOrderId || existing.organizerUid !== organizerUid) return 'no_pending'
  const remainder = Math.max(0, existing.razorpayAmountPaise ?? 0)
  const lookup = await findCapturedLicensePayment(existing.razorpayOrderId, remainder)
  if (lookup.state === 'unknown' || (lookup.state === 'captured' && lookup.paymentStatus !== 'captured')) return 'unknown'
  if (lookup.state === 'none') return 'unpaid'
  const rdef = isValidTierForVersion(existing.tier, CURRENT_LICENSE_VERSION)
    ? await getEffectiveDefinitionForVersion(existing.tier, CURRENT_LICENSE_VERSION) : null
  if (!rdef) return 'unapplied'
  const act = await activateLicenseOrder({
    eventId: draftId, uid: organizerUid, tier: existing.tier, licenseName: rdef.name,
    basePricePaise: orderListPricePaise(existing, rdef.licensePricePaise), persisted: existing,
    razorpayOrderId: existing.razorpayOrderId, razorpayPaymentId: lookup.paymentId,
  })
  if (act.kind === 'ok' || act.kind === 'already') {
    scheduleServicePurchaseNotification(`lic_${draftId}`)
    return 'activated'
  }
  if (act.kind === 'superseded') return 'unknown'
  if (act.kind === 'photo_capacity_exceeded') {
    await holdPhotoCapacityExceeded({ eventId: draftId, orderId: existing.razorpayOrderId, paymentId: lookup.paymentId, amountPaise: remainder })
    return 'held'
  }
  if (act.kind === 'coupon_exhausted') {
    await holdExhaustedCouponRemainder({ eventId: draftId, orderId: existing.razorpayOrderId, paymentId: lookup.paymentId, remainderPaise: remainder, persisted: existing })
    return 'held'
  }
  captureFinancialError('license_settle_unapplied', { scope: 'license.settle_unapplied', eventId: draftId, orderId: existing.razorpayOrderId, paymentId: lookup.paymentId, kind: act.kind })
  return 'unapplied'
}
