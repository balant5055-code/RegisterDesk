// Shared license-purchase finalization (GA-8 P1-1). Server-only.
//
// Extracted VERBATIM from app/api/licensing/checkout/confirm/route.ts so the
// activation transaction has ONE implementation shared by every recovery path:
//   • /api/licensing/checkout/confirm      — the client-driven happy path
//   • /api/webhooks/razorpay               — captured-payment backstop (no intent)
//   • /api/licensing/purchase (self-heal)  — retry after a captured-but-unconfirmed pay
//
// A single implementation is deliberate: divergent activation logic across paths is
// exactly how a payments platform ends up double-settling. Every write is keyed by a
// deterministic id (`lic_<eventId>`), so a replay is idempotent — the transaction
// short-circuits when the order is already `paid`.
//
// RD-LICENSE-PAYMENT-01 · activation is paid through RAZORPAY ONLY. The communication
// wallet (`organizerWallets`) is a separate financial system for WhatsApp / bulk / SMS usage
// and is never read, debited or written here — no wallet share, no `walletTransactions`
// row. An order whose Razorpay amount does not cover its full price (a pre-change order
// that planned a wallet share) is refused as `underpaid`, never activated at a discount.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { recordManualRefundHold } from './manualRefundHold'
import { licenseCouponRef, organizerRedemptionCounterRef, organizerPaidRedemptionsQuery } from '@/lib/licensing/coupons'
import {
  LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION,
  licenseOrderConverter, licenseHistoryConverter,
  type LicenseOrderDoc, type LicenseHistoryDoc, type CapacityChargeSnapshot,
} from '@/lib/licensing/schema'
import type { AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { sumServiceItems } from '@/lib/licensing/serviceAllowances'
import { ledgerRef, txnApplyServiceItems, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { checkPhotoPurchase, mediaUnitsIn, paidPhotoCapacity } from '@/lib/licensing/photoCapacity'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

// RD-F1 — 'ineligible': the stored activation order is not grantable (failed / on hold / refunded /
// unknown status). Nothing is written.
// RD-M4 — 'superseded': `lic_{eventId}` now carries a DIFFERENT Razorpay order than the payment being
// activated (the order was replaced after the caller read it). Nothing is written; the caller holds the
// payment on its F2A archive (or retries), never applies it over the current order.
/**
 * RD-PHOTO-01 · 'photo_capacity_exceeded' — the order's photo units would take the event above 3,000
 * (e.g. units carried in after the order was priced). Nothing is written; the caller records a
 * manual-refund hold (holdPhotoCapacityExceeded), exactly like an exhausted coupon.
 */
export type LicenseActivationKind = 'ok' | 'already' | 'underpaid' | 'coupon_exhausted' | 'ineligible' | 'superseded' | 'photo_capacity_exceeded'

/** Pure derivation of what the persisted order says Razorpay must collect — the SINGLE
 *  source both the pre-txn verification (confirm route) and the activation transaction
 *  read from, so they can never disagree.
 *
 *  `razorpayAmountPaise` is the amount the Razorpay order was created for. Razorpay pays
 *  the WHOLE price, so a payable order must carry razorpayAmountPaise === finalPricePaise;
 *  `underpaid` marks one that does not (e.g. a pre-RD-LICENSE-PAYMENT-01 order that planned
 *  a wallet share) — it must never activate. A ₹0 final price (fully discounted) needs no
 *  payment at all. */
export function deriveLicenseCharge(
  persisted: LicenseOrderDoc | null,
  basePricePaise: number,
): {
  alreadyPaid: boolean
  finalPricePaise: number
  couponCode: string | null
  razorpayAmountPaise: number
  underpaid: boolean
  expectedOrderId: string | null
} {
  const alreadyPaid         = persisted?.status === 'paid'
  const finalPricePaise     = typeof persisted?.finalPricePaise === 'number' ? persisted.finalPricePaise : basePricePaise
  const couponCode          = typeof persisted?.couponCode === 'string' ? persisted.couponCode : null
  const razorpayAmountPaise = alreadyPaid ? 0 : Math.max(0, persisted?.razorpayAmountPaise ?? 0)
  const expectedOrderId     = persisted?.razorpayOrderId ?? null
  const underpaid           = !alreadyPaid && finalPricePaise > 0 && razorpayAmountPaise !== finalPricePaise
  return { alreadyPaid, finalPricePaise, couponCode, razorpayAmountPaise, underpaid, expectedOrderId }
}

/**
 * RD-EVENT-COMMERCE-02 · the pre-coupon LIST price an order was created for: its capacity
 * snapshot total (or the tier price for a legacy tier order) plus every prepaid service line.
 * The ONE figure confirm, the webhook backstop and the purchase self-heal pass as
 * `basePricePaise`, so a combined capacity + services order is never mistaken for underpaid.
 */
export function orderListPricePaise(
  order: Pick<LicenseOrderDoc, 'capacityChange' | 'serviceItems'> | null | undefined,
  tierFallbackPaise: number,
): number {
  return (order?.capacityChange ? order.capacityChange.totalPaise : tierFallbackPaise) + sumServiceItems(order?.serviceItems)
}

export interface ActivateLicenseOrderInput {
  eventId:           string
  uid:               string
  tier:              AnyEventLicenseTier
  licenseName:       string             // def.name — kept for callers; the history note is payment-method only
  basePricePaise:    number             // def.licensePricePaise — coupon-free fallback
  persisted:         LicenseOrderDoc | null
  razorpayOrderId:   string | null      // stamped onto the paid order
  razorpayPaymentId: string | null      // stamped onto the paid order
  /**
   * RD-CAPACITY-01 · the immutable pricing record for a capacity-priced activation.
   * ADDITIVE and OPTIONAL: absent ⇒ a tier-priced purchase, and this transaction behaves
   * exactly as it did before. Present ⇒ the snapshot is written onto the paid order and
   * the order is marked `commercialModel: 'capacity'`, so the event's publish step reads
   * the EXACT purchased capacity from the order the payment produced rather than deriving
   * it from a tier.
   *
   * It rides on THIS transaction — the single activation implementation — deliberately.
   * A second "activate a capacity order" function would be a second place for a payment
   * to be settled, which is how a payments platform double-settles.
   */
  capacitySnapshot?: CapacityChargeSnapshot
}

export interface ActivateLicenseOrderResult {
  kind:                LicenseActivationKind
  razorpayAmountPaise: number
  finalPricePaise:     number
  couponCode:          string | null
}

/**
 * The license activation transaction — redeems the coupon, flips the order to `paid`,
 * and appends immutable history, all atomically. The Razorpay payment is verified by the
 * CALLER before this runs; this transaction touches no wallet of any kind.
 * Idempotent: a re-run on an already-`paid` order returns `already` and writes
 * nothing. Never throws for business outcomes (underpaid / coupon_exhausted);
 * the caller maps those to its own response + refund handling.
 */
export async function activateLicenseOrder(input: ActivateLicenseOrderInput): Promise<ActivateLicenseOrderResult> {
  const { eventId, uid, tier, basePricePaise } = input
  // The caller's snapshot is only the starting point; inside the transaction the CURRENT order wins
  // (RD-M4). Kept in an outer variable so the result reports what the transaction actually used.
  let charge = deriveLicenseCharge(input.persisted, basePricePaise)

  const orderRef   = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter)
  const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc().withConverter(licenseHistoryConverter)

  const kind = await adminDb.runTransaction<LicenseActivationKind>(async (txn) => {
    // READS first.
    const orderSnap = await txn.get(orderRef)
    if (orderSnap.exists && orderSnap.data()?.status === 'paid') return 'already'
    // RD-F1 — an existing order grants capacity only from `created` with no refund hold. A failed
    // (e.g. coupon-exhausted hold), refunded or unknown-status order is refused inside the transaction.
    if (orderSnap.exists) {
      const cur = orderSnap.data() as { status?: unknown; manualRefundHoldId?: unknown } | undefined
      if (cur?.status !== 'created' || cur?.manualRefundHoldId != null) return 'ineligible'
    }
    // RD-M4 D1 — the payment must belong to the order that is CURRENT now, not the one the caller read.
    // A replacement between the caller's read and this transaction leaves a different Razorpay order on
    // `lic_`; activating would overwrite it with a stale paid record (and strand its own payment).
    // The ₹0 coupon path has no Razorpay order on either side (null === null) and is unaffected.
    if (orderSnap.exists) {
      const curRzp = (orderSnap.data() as { razorpayOrderId?: unknown } | undefined)?.razorpayOrderId ?? null
      if (curRzp !== (input.razorpayOrderId ?? null)) return 'superseded'
    }
    // Build from the CURRENT document (read in this transaction), never the stale pre-read snapshot.
    const persisted: LicenseOrderDoc | null = orderSnap.exists ? (orderSnap.data() ?? null) : input.persisted
    charge = deriveLicenseCharge(persisted, basePricePaise)
    const { finalPricePaise, couponCode, razorpayAmountPaise, underpaid } = charge
    const couponRef = couponCode ? licenseCouponRef(couponCode) : null
    // RD-EVENT-COMMERCE-02 — prepaid service lines are applied to the event's allowance
    // ledger IN THIS transaction, so "paid" and "allowance granted" can never disagree.
    const serviceItems = persisted?.serviceItems ?? []
    const ledgerSnap = serviceItems.length > 0 ? await txn.get(ledgerRef(eventId)) : null
    // EA-4 S2 / GA-7B: include the coupon in the read set AND re-check its usage
    // cap INSIDE the txn, so concurrent confirms can't push currentUses past
    // usageLimit. The loser of a race for the last use is rejected here (txn rolls
    // back → no increment, no activation) and its remainder refunded by the caller.
    // RD-M5 D1 — the per-organizer counter write to make with the activation (null ⇒ none).
    let organizerCounter: { ref: FirebaseFirestore.DocumentReference; next: number } | null = null
    if (couponRef && couponCode) {
      const couponSnap = await txn.get(couponRef)
      if (couponSnap.exists) {
        const c = couponSnap.data() as { usageLimit?: number | null; currentUses?: number; perOrganizerLimit?: number | null }
        if (c.usageLimit != null && (c.currentUses ?? 0) >= c.usageLimit) {
          return 'coupon_exhausted'
        }
        // ── RD-M5 D1 · perOrganizerLimit enforced HERE, atomically with the redemption ─────────
        // The counter doc is the contention point: two first-time activations for the same
        // organizer + coupon both read it (missing) and both write it, so Firestore serialises them
        // and the loser re-runs with the winner's count. A retry re-reads everything; the write is
        // an absolute value computed from this transaction's read, so it can never double-count.
        const limit = typeof c.perOrganizerLimit === 'number' && Number.isFinite(c.perOrganizerLimit) ? c.perOrganizerLimit : null
        const counterRef  = organizerRedemptionCounterRef(couponCode, uid)
        const counterSnap = await txn.get(counterRef)
        const stored = counterSnap.exists ? (counterSnap.data() as { count?: unknown }).count : undefined
        const storedOk = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0
        // Only coupons WITH a limit create a counter; an existing one is always kept current.
        if (limit !== null || counterSnap.exists) {
          // Legacy / missing / unreadable counter: seed from this organizer's PAID redemptions,
          // read INSIDE this transaction (never assumed to be 0). The current order is still
          // `created`, so it is not part of the seed.
          const used = storedOk ? stored as number : (await txn.get(organizerPaidRedemptionsQuery(couponCode, uid))).size
          if (limit !== null && used >= limit) return 'coupon_exhausted'
          organizerCounter = { ref: counterRef, next: used + 1 }
        }
      }
    }

    // Razorpay must have been asked for the WHOLE price. A shortfall is never made up
    // from any wallet — the order is refused and left for the caller to surface.
    if (underpaid) return 'underpaid'
    // RD-PHOTO-01 — never past 3,000 photos for the event (checked BEFORE any write; the ledger's own
    // throw stays as an assertion only).
    const mediaAdding = mediaUnitsIn(serviceItems)
    if (mediaAdding > 0 && ledgerSnap) {
      const l = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
      if (!checkPhotoPurchase(paidPhotoCapacity(l?.media), mediaAdding).ok) return 'photo_capacity_exceeded'
    }

    // WRITES.

    const orderDoc: LicenseOrderDoc = {
      orderId:           `lic_${eventId}`,
      eventId,
      organizerUid:      uid,
      tier,
      fromTier:          null,
      purpose:           'purchase',
      amountPaise:       finalPricePaise,   // FINAL charged (revenue-correct)
      currency:          'INR',
      status:            'paid',
      razorpayOrderId:   input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      createdAt:         now(),
      updatedAt:         now(),
      paidAt:            now(),
      // EA-4 S2: carry the coupon accounting + immutable snapshot onto the paid order.
      ...(couponCode ? {
        couponCode,
        campaign:           persisted?.campaign ?? null,
        originalPricePaise: persisted?.originalPricePaise ?? basePricePaise,
        discountPaise:      persisted?.discountPaise ?? (basePricePaise - finalPricePaise),
        finalPricePaise,
        couponSnapshot:     persisted?.couponSnapshot ?? null,
      } : {}),
      // RD-CAPACITY-01 — freeze the capacity pricing onto the paid order. Taken from the
      // ARGUMENT (which the route recomputed server-side from the authoritative terms),
      // falling back to whatever the created order already carried, so a webhook or
      // self-heal replay that has no quote of its own still preserves the record.
      ...(input.capacitySnapshot ?? persisted?.capacityChange
        ? {
            commercialModel: 'capacity' as const,
            capacityChange:  input.capacitySnapshot ?? persisted?.capacityChange,
          }
        : {}),
      // RD-EVENT-COMMERCE-02 — the service lines and the selection travel onto the paid order.
      ...(serviceItems.length > 0 ? { serviceItems, servicesTotalPaise: persisted?.servicesTotalPaise ?? sumServiceItems(serviceItems) } : {}),
      ...(persisted?.selection ? { selection: persisted.selection } : {}),
    }
    txn.set(orderRef, orderDoc)
    if (ledgerSnap) {
      txnApplyServiceItems(txn, ledgerSnap, { draftId: eventId, organizerUid: uid, orderId: `lic_${eventId}`, items: serviceItems })
    }

    // EA-4 S2: redeem the coupon (global counter) atomically with activation.
    if (couponRef) {
      txn.set(couponRef, { currentUses: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    // RD-M5 D1 — the organizer's redemption count, committed with the paid order and the global use.
    if (organizerCounter) {
      txn.set(organizerCounter.ref, { count: organizerCounter.next, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }

    const historyDoc: LicenseHistoryDoc = {
      id:           historyRef.id,
      eventId,
      organizerUid: uid,
      action:       'purchased',
      fromTier:     null,
      toTier:       tier,
      source:       'self_serve',
      orderId:      `lic_${eventId}`,
      actorUid:     uid,
      note:         couponCode
        ? `License purchased — coupon ${couponCode} (−${persisted?.discountPaise ?? 0}), razorpay ${razorpayAmountPaise}`
        : `License purchased — razorpay ${razorpayAmountPaise}`,
      createdAt:    now(),
      // RD-CAPACITY-01 — the trail carries the pricing record itself, not a pointer to
      // it, so the history entry stays explicable even if the order is later archived.
      // `action` stays 'purchased': the existing admin timeline renders that label, and a
      // new action value would be an unlabelled row for a real payment.
      ...(input.capacitySnapshot ?? persisted?.capacityChange
        ? { after: input.capacitySnapshot ?? persisted?.capacityChange }
        : {}),
    }
    txn.set(historyRef, historyDoc)

    return 'ok'
  })

  return { kind, razorpayAmountPaise: charge.razorpayAmountPaise, finalPricePaise: charge.finalPricePaise, couponCode: charge.couponCode }
}

/**
 * The activation was refused because the coupon hit its usage limit between checkout and
 * confirm, so a captured amount is held for a service RegisterDesk declined to provide.
 *
 * ═══ RD-EVENT-COMMERCE-04B · NO AUTOMATIC REFUND ═════════════════════════════
 * Confirmed business rule: RegisterDesk never refunds automatically — not from a webhook, a
 * confirm route, a self-heal, a job or any system condition. This used to call the gateway
 * directly (the documented RD-PAYMENT-REFUND-AUTHORITY-02 exception for organizer
 * overpayments); that exception is withdrawn.
 *
 * It now records a MANUAL-REFUND HOLD and moves no money: one transaction creates
 * `failedRefunds/license_hold_{orderDocId}` (`status: 'open'`, `kind: 'license_remainder_hold'`)
 * and marks the order failed with a pointer to it. A Super Admin then either refunds it
 * explicitly (POST /api/admin/failed-refunds/[id]/retry — resolveSuperAdminUid, claimed in a
 * transaction before the gateway call) or closes it (PATCH …/[id]: resolved / ignored).
 *
 * Idempotent: the hold id is deterministic, so the webhook, the confirm route and the
 * purchase self-heal racing each other create ONE hold. An order that was already refunded
 * under the old behaviour (`couponExhaustedRefundId`) gets no hold. Never throws.
 */
/**
 * RD-PHOTO-01 — the activation was refused because its photo units would exceed the event's 3,000
 * maximum. The captured payment is recorded as a MANUAL-REFUND HOLD (no automatic refund), the same
 * Super Admin queue every other licence hold uses. Idempotent; never throws unless asked to.
 */
export async function holdPhotoCapacityExceeded(input: {
  eventId: string; orderId: string | null; paymentId: string | null; amountPaise: number
}, opts: { rethrow?: boolean } = {}): Promise<void> {
  if (input.amountPaise <= 0 || !input.paymentId) return
  try {
    await recordManualRefundHold({
      orderDocId: `lic_${input.eventId}`, razorpayOrderId: input.orderId, paymentId: input.paymentId, amountPaise: input.amountPaise,
      eventId: input.eventId, reason: 'photo_capacity_exceeded', source: 'license', failReason: 'photo_capacity_exceeded',
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'license.photo_capacity_hold', eventId: input.eventId, paymentId: input.paymentId, orderId: input.orderId, amount: input.amountPaise })
    if (opts.rethrow) throw err
  }
}

export const PHOTO_CAPACITY_HELD_MESSAGE =
  'This purchase would take the event above its maximum of 3,000 photos, so nothing was activated. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged.'

export async function holdExhaustedCouponRemainder(input: {
  eventId:        string
  orderId:        string | null
  paymentId:      string | null
  remainderPaise: number
  persisted:      LicenseOrderDoc | null
}, opts: { rethrow?: boolean } = {}): Promise<void> {
  // RD-F3 — `rethrow`: the webhook needs a failed hold write to surface (non-2xx ⇒ Razorpay retries);
  // every other caller keeps the previous never-throws behaviour.
  const { eventId, orderId, paymentId, remainderPaise, persisted } = input
  const priorRefundId = (persisted as { couponExhaustedRefundId?: string } | null)?.couponExhaustedRefundId
  if (remainderPaise <= 0 || !paymentId || priorRefundId != null) return
  const orderDocId = `lic_${eventId}`
  try {
    await recordManualRefundHold({
      orderDocId, razorpayOrderId: orderId, paymentId, amountPaise: remainderPaise, eventId,
      reason: 'coupon_exhausted', source: 'license', failReason: 'coupon_exhausted',
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'license.coupon_exhausted_hold', eventId, paymentId, orderId, amount: remainderPaise })
    if (opts.rethrow) throw err
  }
}

