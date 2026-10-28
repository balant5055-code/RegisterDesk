// RD-EVENT-COMMERCE-02 · What a DRAFT has paid for, and pre-publish add-on orders. Server-only.
//
// ═══ COVERAGE ════════════════════════════════════════════════════════════════
// A draft's paid coverage is read ONLY from server-written records:
//   capacity  = the capacity on its PAID activation order (`lic_<draftId>`), raised by any
//               PAID add-on order (`add_<draftId>_<n>`) that bought more
//   services  = the event's service-allowance ledger (`eventServiceAllowances/<draftId>`)
// Nothing here reads the draft's own selection: a draft is client-writable, so it can only ever
// be the thing being CHECKED, never the thing that proves payment.
//
// ═══ ADD-ON ORDERS ═══════════════════════════════════════════════════════════
// `lic_<draftId>` is a singleton (the activation). An organizer who raises capacity or service
// quantities AFTER paying it — still before publishing — buys the DIFFERENCE through an add-on
// order. Capacity is priced as an INCREASE from the paid capacity under the terms frozen on the
// activation order (so a later rate change cannot reprice an activated draft); service units are
// priced from the current catalog. At most ONE add-on order is payable at a time
// (`pendingAddonOrderId` on the ledger); a changed selection supersedes an unpaid one, and a
// pending one that already has a captured payment is never superseded.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }  from '@/lib/firebase/admin'
import { razorpay } from '@/lib/razorpay/client'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION, licenseOrderConverter, licenseHistoryConverter,
  type LicenseOrderDoc, type LicenseHistoryDoc,
} from './schema'
import {
  SERVICE_KINDS, sumServiceItems, isConsistentServiceItem, withMediaBaseCap,
  type ServiceSelection, type ServiceAllowancesConfig,
} from './serviceAllowances'
import { ledgerRef, txnApplyServiceItems, type ServiceLedgerDoc } from './serviceAllowanceLedger'
import { checkPhotoPurchase, mediaUnitsIn, paidPhotoCapacity } from './photoCapacity'
import { quoteAddon, type DraftCoverage } from './draftCoverage'
import { licenceRegistrationBlock } from './licenceRegistrationBlock'
import { isReviewClosed } from '@/lib/events/lifecycleStateMachine'
import { recordManualRefundHold, recordDuplicateLicensePayment } from './manualRefundHold'
export { readDraftCoverage, quoteAddon, type DraftCoverage } from './draftCoverage'
import type { AnyEventLicenseTier } from './eventLicense'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

// ─── Add-on order lifecycle ───────────────────────────────────────────────────

const sameSelection = (a: LicenseOrderDoc['selection'] | undefined, capacity: number, services: ServiceSelection) =>
  !!a && a.capacity === capacity && SERVICE_KINDS.every(k => (a.services?.[k] ?? 0) === (services[k] ?? 0))

async function hasCapturedPayment(razorpayOrderId: string, amountPaise: number): Promise<boolean | 'unknown'> {
  try {
    const res = await razorpay.orders.fetchPayments(razorpayOrderId) as { items?: unknown } | null | undefined
    // RD-M3 — a response without an `items` array cannot establish "nothing captured": unknown.
    if (!res || !Array.isArray(res.items)) return 'unknown'
    return (res.items as Array<{ status?: string; amount?: number; currency?: string } | null>)
      .some(p => !!p && (p.status === 'captured' || p.status === 'authorized') && p.currency === 'INR' && p.amount === amountPaise)
  } catch {
    return 'unknown'
  }
}

/** The workspace's live events for a draft (events/{slug}.draftId is written by publish only). */
const liveEventsForDraft = (draftId: string) => adminDb.collection('events').where('draftId', '==', draftId)

async function addonLicenceBlocked(draftId: string, organizerUid: string): Promise<boolean> {
  const live = (await liveEventsForDraft(draftId).get()).docs.filter(d => d.get('uid') === organizerUid)
  if (!live.length) return false
  const lics = await adminDb.getAll(...live.map(d => adminDb.collection(EVENT_LICENSES_COLLECTION).doc(d.id)))
  return lics.some(l => licenceRegistrationBlock(l.exists ? l.data() : undefined))
}

export type AddonPurchaseResult =
  | { kind: 'covered' }
  | { kind: 'checkout'; orderId: string; razorpayOrderId: string; amountPaise: number; reused: boolean; order: LicenseOrderDoc }
  | { kind: 'processing' }
  | { kind: 'error'; message: string }

/**
 * Creates (or reuses) the single payable add-on order for a draft whose activation is PAID.
 * The caller has validated ownership, the capacity and every service quantity.
 */
export async function purchaseAddon(args: {
  draftId: string; organizerUid: string; tier: AnyEventLicenseTier
  capacity: number; services: ServiceSelection; catalog: ServiceAllowancesConfig
  coverage: DraftCoverage
  /** 2026-10-02 — the event's base photo limit now, recorded on any media line (withMediaBaseCap). */
  mediaBaseCap?: number | null
}): Promise<AddonPurchaseResult> {
  const { draftId, organizerUid, capacity, services, coverage } = args
  const quote = quoteAddon({ coverage, capacity, services, catalog: args.catalog })
  if (!quote.ok) return { kind: 'error', message: quote.message }
  if (quote.totalPaise <= 0) return { kind: 'covered' }
  // RD-SA-COMMERCE-P1 — never open a checkout for a published event whose licence is inactive
  // (settlement re-checks in its transaction and holds any payment that still arrives).
  if (await addonLicenceBlocked(draftId, organizerUid)) {
    return { kind: 'error', message: "This event's licence is not active (suspended, cancelled or refunded), so nothing can be bought for it. Contact RegisterDesk support." }
  }

  // RD-PHOTO-01 — the photo units this order adds may never take the event above 3,000. Checked
  // against the ledger here (before any Razorpay order exists) and again in the pointer
  // transaction below and at settlement (activateAddonOrder).
  const mediaAdding = mediaUnitsIn(quote.serviceItems)
  const photoFits = (l: ServiceLedgerDoc | undefined) =>
    mediaAdding === 0 || checkPhotoPurchase(paidPhotoCapacity(l?.organizerUid === organizerUid ? l.media : undefined), mediaAdding)
  if (mediaAdding > 0) {
    const pre = await ledgerRef(draftId).get()
    const fits = photoFits(pre.exists ? pre.data() as ServiceLedgerDoc : undefined)
    if (fits !== true && !fits.ok) return { kind: 'error', message: fits.message }
  }

  const pending = coverage.pendingAddon
  if (pending?.razorpayOrderId) {
    if (sameSelection(pending.selection, capacity, services) && pending.amountPaise === quote.totalPaise) {
      return { kind: 'checkout', orderId: pending.orderId, razorpayOrderId: pending.razorpayOrderId, amountPaise: pending.amountPaise, reused: true, order: pending }
    }
    // A different selection: supersede the unpaid order — unless money may already be on it.
    const captured = await hasCapturedPayment(pending.razorpayOrderId, pending.amountPaise)
    if (captured !== false) return { kind: 'processing' }
    // RD-M4 D3 — supersede ONLY if the add-on is still exactly what was checked (re-read in a
    // transaction: `created`, unheld, same Razorpay order). One settled meanwhile (now `paid`, its units
    // already in the ledger) is never flipped to "superseded".
    const pendingRef = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(pending.orderId)
    const superseded = await adminDb.runTransaction(async txn => {
      const cur = await txn.get(pendingRef)
      const c = cur.exists ? cur.data() as Record<string, unknown> : undefined
      if (!c || c.status !== 'created' || c.manualRefundHoldId != null || c.razorpayOrderId !== pending.razorpayOrderId) return false
      txn.set(pendingRef, { status: 'failed', failReason: 'superseded', updatedAt: now() }, { merge: true })
      return true
    })
    if (!superseded) return { kind: 'processing' }
  }

  const orderId = `add_${draftId}_${Date.now().toString(36)}`
  let razorpayOrderId: string
  try {
    const rz = await razorpay.orders.create({
      amount: quote.totalPaise, currency: 'INR', receipt: orderId.slice(0, 40),
      notes: { kind: 'license', purpose: 'addon', eventId: draftId, organizerUid, orderId },
    })
    razorpayOrderId = rz.id
  } catch {
    return { kind: 'error', message: 'Failed to create payment order' }
  }
  const order: LicenseOrderDoc = {
    orderId, eventId: draftId, organizerUid, tier: args.tier, fromTier: null, purpose: 'addon',
    amountPaise: quote.totalPaise, currency: 'INR', status: 'created',
    razorpayOrderId, razorpayPaymentId: null, razorpayAmountPaise: quote.totalPaise,
    ...(quote.capacityCharge ? { commercialModel: 'capacity' as const, capacityChange: quote.capacityCharge } : {}),
    ...(quote.serviceItems.length ? { serviceItems: withMediaBaseCap(quote.serviceItems, args.mediaBaseCap ?? null), servicesTotalPaise: sumServiceItems(quote.serviceItems) } : {}),
    selection: { capacity, services: { ...services } },
    createdAt: now(), updatedAt: now(), paidAt: null,
  }
  // The pointer and the order are written together; a racing request that already set a
  // different pointer wins, and this order is left unreferenced (unpayable through the UI).
  const lost = await adminDb.runTransaction(async txn => {
    const l = await txn.get(ledgerRef(draftId))
    const current = l.exists ? (l.data() as ServiceLedgerDoc).pendingAddonOrderId ?? null : null
    if (current && current !== (pending?.orderId ?? null)) return true
    const fits = photoFits(l.exists ? l.data() as ServiceLedgerDoc : undefined)
    if (fits !== true && !fits.ok) return true
    txn.set(adminDb.collection(LICENSE_ORDERS_COLLECTION).withConverter(licenseOrderConverter).doc(orderId), order)
    txn.set(ledgerRef(draftId), { draftId, organizerUid, pendingAddonOrderId: orderId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return false
  })
  if (lost) return { kind: 'processing' }
  return { kind: 'checkout', orderId, razorpayOrderId, amountPaise: quote.totalPaise, reused: false, order }
}

/**
 * RD-PHOTO-01 · 'over_capacity' — a captured add-on whose photo units would take the event above
 * 3,000 (a concurrent photo purchase settled first). Nothing is granted; the order is marked
 * superseded in the same transaction so the caller records the standard manual-refund hold.
 */
export type AddonActivationKind = 'ok' | 'already' | 'not_payable' | 'inconsistent' | 'over_capacity' | 'licence_inactive'

/**
 * RD-SA-COMMERCE-P1 · 'licence_inactive' — the published event's licence is suspended, cancelled,
 * refunded or mid-refund, so no units may be granted. The settlement transaction marks the order
 * failed with this reason and releases the add-on slot; the caller then records THE manual-refund
 * hold (holdLicenceInactiveAddon). A crash between the two leaves a failed, unheld order, and the
 * next delivery / confirm retry sees 'licence_inactive' again and completes the same hold.
 */
export const ADDON_LICENCE_INACTIVE = 'licence_inactive'
/** RD-REVIEW-02 — `failDetail` on an add-on refused because its event was closed during review. */
export const ADDON_EVENT_REVIEW_CLOSED = 'event_review_closed'

export async function holdLicenceInactiveAddon(input: {
  orderId: string; razorpayOrderId: string; paymentId: string; amountPaise: number; eventId: string; organizerUid: string
  detectedBy: 'webhook' | 'confirm'
}): Promise<{ holdId: string; created: boolean; skipped?: boolean }> {
  const held = await recordManualRefundHold({
    orderDocId: input.orderId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId,
    amountPaise: input.amountPaise, eventId: input.eventId, organizerUid: input.organizerUid,
    reason: 'lifecycle_ineligible', source: 'license', failReason: ADDON_LICENCE_INACTIVE,
    onlyIfOrder: (o, holdId) => o?.purpose === 'addon' && o?.status === 'failed' && o?.failReason === ADDON_LICENCE_INACTIVE
      && (o?.manualRefundHoldId == null || o?.manualRefundHoldId === holdId) && o?.razorpayOrderId === input.razorpayOrderId,
  })
  if (held.created || held.skipped) return held
  // The order's hold already exists: for THIS payment it is the answer; a different captured payment on
  // the same order is real money nothing else records — held separately, never granted.
  const h = await adminDb.collection('failedRefunds').doc(held.holdId).get()
  const heldPayment = h.exists ? (h.data() as { paymentId?: unknown }).paymentId : null
  if (heldPayment === input.paymentId) return held
  const dup = await recordDuplicateLicensePayment({
    orderDocId: input.orderId, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId,
    creditedPaymentId: typeof heldPayment === 'string' ? heldPayment : null, amountPaise: input.amountPaise,
    eventId: input.eventId, organizerUid: input.organizerUid, detectedBy: input.detectedBy,
  })
  return { holdId: dup.holdId, created: dup.created }
}

/**
 * The add-on settlement transaction — shared by /checkout/confirm and the webhook backstop.
 * The Razorpay payment is verified by the CALLER (signature and/or captured amount against
 * `razorpayAmountPaise`). Idempotent: a paid order returns `already` and writes nothing.
 */
export async function activateAddonOrder(input: {
  orderId: string; razorpayOrderId: string | null; razorpayPaymentId: string | null
}): Promise<AddonActivationKind> {
  const orderRef = adminDb.collection(LICENSE_ORDERS_COLLECTION).withConverter(licenseOrderConverter).doc(input.orderId)
  const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).withConverter(licenseHistoryConverter).doc()
  return adminDb.runTransaction<AddonActivationKind>(async txn => {
    const snap = await txn.get(orderRef)
    const o = snap.exists ? snap.data() : undefined
    if (!o || o.purpose !== 'addon') return 'not_payable'
    if (o.status === 'paid') return 'already'
    // Refused earlier for an inactive licence: report it again so the caller (re)completes the hold.
    if (o.status === 'failed' && (o as { failReason?: unknown }).failReason === ADDON_LICENCE_INACTIVE) return 'licence_inactive'
    if (o.status !== 'created') return 'not_payable'
    const items = o.serviceItems ?? []
    const cap = o.capacityChange ?? null
    const capOk = !cap || (cap.basePaise + cap.gstPaise === cap.totalPaise && cap.chargeableCapacity * cap.activationRatePaise === cap.basePaise)
    const total = (cap?.totalPaise ?? 0) + sumServiceItems(items)
    if (!capOk || !items.every(isConsistentServiceItem) || total !== o.amountPaise || o.razorpayAmountPaise !== o.amountPaise) return 'inconsistent'
    const ledgerSnap = await txn.get(ledgerRef(o.eventId))
    // RD-SA-COMMERCE-P1 — the licence of this workspace's live event for the draft (events/{slug}.draftId
    // is server-written by publish). A draft that was never published has no live event and no licence.
    const live = (await txn.get(liveEventsForDraft(o.eventId))).docs.filter(d => d.get('uid') === o.organizerUid)
    const lics = await Promise.all(live.map(d => txn.get(adminDb.collection(EVENT_LICENSES_COLLECTION).doc(d.id))))
    // RD-REVIEW-02 — an event closed during review (owner closure or expired deadlines) is permanently
    // closed: a checkout opened before the closure but paid after it grants nothing. It takes the SAME
    // refusal as an inactive licence (order failed, slot released, the caller holds the captured
    // payment for a Super Admin decision — never an automatic refund); `failDetail` only lets the
    // organizer-facing message say why.
    const reviewClosed = live.some(d => isReviewClosed(d.data()))
    if (reviewClosed || lics.some(l => licenceRegistrationBlock(l.exists ? l.data() : undefined))) {
      txn.set(adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(o.orderId), {
        status: 'failed', failReason: ADDON_LICENCE_INACTIVE, updatedAt: now(),
        ...(reviewClosed ? { failDetail: ADDON_EVENT_REVIEW_CLOSED } : {}),
      }, { merge: true })
      if ((ledgerSnap.data() as ServiceLedgerDoc | undefined)?.pendingAddonOrderId === o.orderId) {
        txn.set(ledgerRef(o.eventId), { pendingAddonOrderId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      return 'licence_inactive'
    }
    const mediaAdding = mediaUnitsIn(items)
    if (mediaAdding > 0) {
      const l = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
      if (!checkPhotoPurchase(paidPhotoCapacity(l?.media), mediaAdding).ok) {
        txn.set(adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(o.orderId), { status: 'failed', failReason: 'superseded', updatedAt: now() }, { merge: true })
        // …and release the single payable add-on slot, or every later service purchase would wait on it.
        if (l?.pendingAddonOrderId === o.orderId) txn.set(ledgerRef(o.eventId), { pendingAddonOrderId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        return 'over_capacity'
      }
    }

    txn.set(orderRef, { ...o, status: 'paid', razorpayOrderId: input.razorpayOrderId ?? o.razorpayOrderId, razorpayPaymentId: input.razorpayPaymentId, paidAt: now(), updatedAt: now() })
    // Applies the service lines (if any) and clears the pending pointer, exactly once.
    txnApplyServiceItems(txn, ledgerSnap, { draftId: o.eventId, organizerUid: o.organizerUid, orderId: o.orderId, items, clearPendingAddon: true })
    const history: LicenseHistoryDoc = {
      id: historyRef.id, eventId: o.eventId, organizerUid: o.organizerUid, action: 'purchased',
      fromTier: null, toTier: o.tier, source: 'self_serve', orderId: o.orderId, actorUid: o.organizerUid,
      note: `Add-on purchased — ${[cap ? `capacity ${cap.previousCapacity ?? '?'}→${cap.capacity}` : null, ...items.map(i => `${i.quantity} ${i.service}`)].filter(Boolean).join(', ')} · razorpay ${o.amountPaise}`,
      createdAt: now(),
      ...(cap ? { after: cap } : {}),
    }
    txn.set(historyRef, history)
    return 'ok'
  })
}
