// RD-PRINT-BILL-P4 · Badge purchase ORDER creation, Razorpay attachment, replacement and expiry.
// Server-only.
//
// ORDER OF OPERATIONS (the internal order always exists before any Razorpay order):
//   1. quote (quote.ts) and compare with what the organizer saw (expectedNetPaise)
//   2. same request id ⇒ same order id (sha256): a retry or double-click resolves to the SAME order
//   3. one payable badge order per event (`pendingBadgeOrderId` on the allowance ledger). A different
//      pending order is replaced ONLY when Razorpay confirms nothing was captured or authorised on it
//      (unknown ⇒ refuse); the replacement is re-checked in a transaction
//   4. TRANSACTION: create the order (tx.create — immutable snapshot, at most one bound coupon) + take the slot
//   5. free order (net 0): activate now, through the same activation transaction — no Razorpay
//   6. paid: razorpay.orders.create(receipt = orderId), then attach its id ONCE (transaction: still
//      `created`, unheld, no id yet, window open). A Razorpay order whose attach failed was never
//      returned to anyone, so it cannot be paid; a retry of the same request creates a fresh one.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'
import { ledgerRef, type ServiceLedgerDoc } from '../serviceAllowanceLedger'
import { findCapturedLicensePayment } from '../activationSelfHeal'
import {
  BADGE_ORDER_PURPOSE, BADGE_ORDER_TTL_MS, BADGE_CHECKOUT_REUSE_MARGIN_MS, BADGE_REQUEST_ID_RE,
  type BadgePurchaseSnapshot,
} from './pricing'
import { quoteBadgePurchase, badgeEventProblem, type BadgeQuote } from './quote'
import { badgeOrderId, badgeOrderRef, type BadgeOrderDoc } from './orderDoc'
import { activateBadgeOrder } from './settle'

const now = () => FieldValue.serverTimestamp()

export type BadgePurchaseResult =
  | { kind: 'checkout'; orderId: string; razorpayOrderId: string; amountPaise: number; currency: 'INR'; keyId: string; expiresAt: string; reused: boolean; snapshot: BadgePurchaseSnapshot }
  | { kind: 'activated'; orderId: string; snapshot: BadgePurchaseSnapshot }      // free order, units applied
  | { kind: 'paid'; orderId: string }                                             // this request already settled
  | { kind: 'refused'; status: number; code: string; message: string; quote?: BadgeQuote }

const refused = (status: number, code: string, message: string, quote?: BadgeQuote): BadgePurchaseResult =>
  ({ kind: 'refused', status, code, message, ...(quote ? { quote } : {}) })
const PROCESSING = refused(409, 'PAYMENT_PROCESSING', 'A badge payment for this event is already being processed. Refresh in a moment — please do not pay again.')

/** Same terms? (a reused request id must describe the same purchase) */
function sameTerms(a: BadgePurchaseSnapshot, b: BadgePurchaseSnapshot): boolean {
  return a.quantity === b.quantity && a.unitPricePaise === b.unitPricePaise && a.netPaise === b.netPaise
    && a.gstRatePercent === b.gstRatePercent && (a.coupon?.code ?? null) === (b.coupon?.code ?? null)
}

const checkoutOf = (o: BadgeOrderDoc, reused: boolean): BadgePurchaseResult => ({
  kind: 'checkout', orderId: o.orderId, razorpayOrderId: o.razorpayOrderId as string, amountPaise: o.razorpayAmountPaise,
  currency: 'INR', keyId: RAZORPAY_KEY_ID, expiresAt: o.checkoutExpiresAt.toDate().toISOString(), reused, snapshot: o.badgePurchase,
})

/**
 * Replace a pending badge order that is NOT this request's — only when no money can be on it. Never
 * replaces one whose Razorpay status is captured, authorised or unknown.
 */
async function releasePendingSlot(draftId: string, pendingId: string): Promise<boolean> {
  const snap = await badgeOrderRef(pendingId).get()
  const p = snap.exists ? snap.data() as BadgeOrderDoc : undefined
  // A pointer to something that is no longer a payable badge order is stale: free it conditionally.
  if (!p || p.purpose !== BADGE_ORDER_PURPOSE || p.status !== 'created') return clearSlotIf(draftId, pendingId)
  if (p.razorpayOrderId) {
    const lookup = await findCapturedLicensePayment(p.razorpayOrderId, p.razorpayAmountPaise)
    if (lookup.state !== 'none') return false        // captured, authorised or unknown ⇒ never replaced
  }
  // No Razorpay order was ever attached (a free order, or a paid one whose checkout was never handed
  // out): no money can be on it. Superseding it races safely with its own activation — whichever
  // transaction commits first wins; the other sees the changed status and writes nothing.
  return adminDb.runTransaction(async txn => {
    const ref = badgeOrderRef(pendingId)
    const [cur, l] = await Promise.all([txn.get(ref), txn.get(ledgerRef(draftId))])
    const c = cur.exists ? cur.data() as BadgeOrderDoc : undefined
    if (!c || c.status !== 'created' || c.manualRefundHoldId != null || (c.razorpayOrderId ?? null) !== (p.razorpayOrderId ?? null)) return false
    txn.update(ref, { status: 'failed', failReason: 'superseded', updatedAt: now() })
    if ((l.data() as ServiceLedgerDoc | undefined)?.pendingBadgeOrderId === pendingId) {
      txn.set(ledgerRef(draftId), { pendingBadgeOrderId: null, updatedAt: now() }, { merge: true })
    }
    return true
  })
}

async function clearSlotIf(draftId: string, orderId: string): Promise<boolean> {
  return adminDb.runTransaction(async txn => {
    const l = await txn.get(ledgerRef(draftId))
    if ((l.data() as ServiceLedgerDoc | undefined)?.pendingBadgeOrderId !== orderId) return true
    txn.set(ledgerRef(draftId), { pendingBadgeOrderId: null, updatedAt: now() }, { merge: true })
    return true
  })
}

/** Stamp the Razorpay order id ONCE: still created, unheld, no id yet, window still open. */
export async function attachBadgeRazorpayOrder(orderId: string, razorpayOrderId: string, nowMs: number): Promise<boolean> {
  const ref = badgeOrderRef(orderId)
  return adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    const c = cur.exists ? cur.data() as BadgeOrderDoc : undefined
    if (!c || c.purpose !== BADGE_ORDER_PURPOSE || c.status !== 'created' || c.manualRefundHoldId != null) return false
    if (c.razorpayOrderId != null || c.razorpayAmountPaise <= 0 || c.checkoutExpiresAt.toMillis() <= nowMs) return false
    txn.update(ref, { razorpayOrderId, updatedAt: now() })
    return true
  })
}

export async function createBadgePurchase(args: {
  workspaceUid: string; isOwner: boolean; callerUid: string; slug: string
  quantity: unknown; couponCode?: unknown; requestId: unknown; expectedNetPaise: unknown; nowMs?: number
}): Promise<BadgePurchaseResult> {
  const nowMs = args.nowMs ?? Date.now()
  if (typeof args.requestId !== 'string' || !BADGE_REQUEST_ID_RE.test(args.requestId)) {
    return refused(400, 'REQUEST_ID_REQUIRED', 'A purchase request id (8–64 letters, digits, _ or -) is required.')
  }
  // RD-PRINT-P8 — order creation reads the pilot FRESH: a removed organizer cannot open a checkout.
  const q = await quoteBadgePurchase({ workspaceUid: args.workspaceUid, isOwner: args.isOwner, slug: args.slug, quantity: args.quantity, couponCode: args.couponCode, nowMs, freshPilot: true })
  if (!q.ok) return refused(q.status, q.code, q.message)
  const quote = q.quote
  if (args.expectedNetPaise !== quote.snapshot.netPaise) {
    return refused(409, 'QUOTE_CHANGED', 'The price changed since it was shown. Review the new total and try again.', quote)
  }
  const orderId = badgeOrderId(quote.draftId, args.workspaceUid, args.requestId)
  const ref = badgeOrderRef(orderId)

  // ── this request already has an order ──
  const existingSnap = await ref.get()
  if (existingSnap.exists) {
    const e = existingSnap.data() as BadgeOrderDoc
    if (e.purpose !== BADGE_ORDER_PURPOSE || e.organizerUid !== args.workspaceUid || e.eventSlug !== args.slug) return refused(404, 'ORDER_NOT_FOUND', 'Order not found.')
    if (!sameTerms(e.badgePurchase, quote.snapshot)) return refused(409, 'REQUEST_REUSED', 'This purchase request was already used for different terms. Start a new purchase.')
    return continueOrder(e, nowMs, true)
  }

  // ── one payable badge order per event ──
  const pre = await ledgerRef(quote.draftId).get()
  const preLedger = pre.exists ? pre.data() as ServiceLedgerDoc : undefined
  if (preLedger && preLedger.organizerUid !== args.workspaceUid) return refused(409, 'LEDGER_OWNER_MISMATCH', 'This event’s allowance belongs to another account.')
  const pendingId = preLedger?.pendingBadgeOrderId ?? null
  if (pendingId && pendingId !== orderId && !(await releasePendingSlot(quote.draftId, pendingId))) return PROCESSING

  // ── create the order and take the slot, together ──
  const order: Omit<BadgeOrderDoc, 'createdAt' | 'updatedAt' | 'checkoutExpiresAt'> & { createdAt: unknown; updatedAt: unknown; checkoutExpiresAt: Timestamp } = {
    orderId, purpose: BADGE_ORDER_PURPOSE, eventId: quote.draftId, eventSlug: quote.slug, organizerUid: args.workspaceUid,
    amountPaise: quote.snapshot.netPaise, razorpayAmountPaise: quote.snapshot.netPaise, currency: 'INR', status: 'created',
    razorpayOrderId: null, razorpayPaymentId: null, badgePurchase: quote.snapshot,
    requestId: args.requestId, createdByUid: args.callerUid, checkoutExpiresAt: Timestamp.fromMillis(nowMs + BADGE_ORDER_TTL_MS),
    couponRedemption: null, failReason: null, manualRefundHoldId: null, expiredAt: null, settledVia: null,
    createdAt: now(), updatedAt: now(), paidAt: null,
  }
  const created = await adminDb.runTransaction(async txn => {
    const [cur, l, ev] = await Promise.all([txn.get(ref), txn.get(ledgerRef(quote.draftId)), txn.get(adminDb.collection('events').doc(quote.slug))])
    if (cur.exists) return 'exists' as const
    const ledger = l.exists ? l.data() as ServiceLedgerDoc : undefined
    if (ledger && ledger.organizerUid !== args.workspaceUid) return 'owner' as const
    if (ledger?.pendingBadgeOrderId && ledger.pendingBadgeOrderId !== orderId) return 'busy' as const
    if (badgeEventProblem(ev.exists ? ev.data() as Record<string, unknown> : undefined, args.workspaceUid, quote.draftId)) return 'event' as const
    txn.create(ref, order)
    txn.set(ledgerRef(quote.draftId), { draftId: quote.draftId, organizerUid: args.workspaceUid, pendingBadgeOrderId: orderId, updatedAt: now() }, { merge: true })
    return 'created' as const
  })
  if (created === 'owner') return refused(409, 'LEDGER_OWNER_MISMATCH', 'This event’s allowance belongs to another account.')
  if (created === 'busy') return PROCESSING
  if (created === 'event') return refused(409, 'EVENT_NOT_ELIGIBLE', 'Badges can be bought only for a published event that is not cancelled, completed or archived.')
  const fresh = (await ref.get()).data() as BadgeOrderDoc
  return continueOrder(fresh, nowMs, created === 'exists')
}

/** From an existing order of THIS request: hand out its checkout, attach one, or activate a free one. */
async function continueOrder(o: BadgeOrderDoc, nowMs: number, reused: boolean): Promise<BadgePurchaseResult> {
  if (o.status === 'paid') return { kind: 'paid', orderId: o.orderId }
  if (o.status !== 'created') return refused(409, 'ORDER_CLOSED', 'This purchase is closed. Start a new purchase.')
  // Free order (net 0): the same activation transaction, no gateway.
  if (o.razorpayAmountPaise === 0) {
    const a = await activateBadgeOrder({ orderId: o.orderId, payment: { kind: 'free' }, via: 'free', nowMs })
    if (a.kind === 'ok' || a.kind === 'already') return { kind: 'activated', orderId: o.orderId, snapshot: o.badgePurchase }
    if (a.kind === 'refused') return refused(409, 'NOT_ACTIVATED', `This free purchase could not be completed (${a.reason.replace(/_/g, ' ')}). Nothing was applied.`)
    return refused(409, 'ORDER_CLOSED', 'This purchase is closed. Start a new purchase.')
  }
  const remaining = o.checkoutExpiresAt.toMillis() - nowMs
  if (o.razorpayOrderId) {
    return remaining > BADGE_CHECKOUT_REUSE_MARGIN_MS ? checkoutOf(o, reused) : refused(409, 'CHECKOUT_EXPIRED', 'This checkout has expired. Start a new purchase.')
  }
  if (remaining <= BADGE_CHECKOUT_REUSE_MARGIN_MS) return refused(409, 'CHECKOUT_EXPIRED', 'This checkout has expired. Start a new purchase.')
  let rzpId: string
  try {
    const rz = await razorpay.orders.create({
      amount: o.razorpayAmountPaise, currency: 'INR', receipt: o.orderId.slice(0, 40),
      notes: { kind: 'license', purpose: BADGE_ORDER_PURPOSE, orderId: o.orderId, eventId: o.eventId, organizerUid: o.organizerUid },
    })
    rzpId = rz.id
  } catch {
    return refused(502, 'GATEWAY_ERROR', 'Could not start the payment. Please try again.')
  }
  if (!(await attachBadgeRazorpayOrder(o.orderId, rzpId, nowMs))) {
    // Another attempt attached first (return ITS checkout) — or the order closed. This Razorpay order
    // was never returned to anyone, so it cannot be paid.
    const cur = (await badgeOrderRef(o.orderId).get()).data() as BadgeOrderDoc | undefined
    if (cur?.status === 'created' && cur.razorpayOrderId) return checkoutOf(cur, true)
    return PROCESSING
  }
  return checkoutOf({ ...o, razorpayOrderId: rzpId }, reused)
}

// ─── The sweep's writes ───────────────────────────────────────────────────────

/** Mark a checkout expired — only while still exactly as checked (created, unheld, same Razorpay id). */
export async function expireBadgeOrder(orderId: string, razorpayOrderId: string | null): Promise<boolean> {
  const ref = badgeOrderRef(orderId)
  return adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    const c = cur.exists ? cur.data() as BadgeOrderDoc : undefined
    if (!c || c.purpose !== BADGE_ORDER_PURPOSE || c.status !== 'created' || c.manualRefundHoldId != null || (c.razorpayOrderId ?? null) !== razorpayOrderId) return false
    const l = await txn.get(ledgerRef(c.eventId))
    // RD-PRINT-BILL-P4.2 — watched for a late capture until the sweep retires it (sweep.ts).
    txn.update(ref, { status: 'expired', expiredAt: now(), lateCaptureWatch: true, updatedAt: now() })
    if ((l.data() as ServiceLedgerDoc | undefined)?.pendingBadgeOrderId === orderId) {
      txn.set(ledgerRef(c.eventId), { pendingBadgeOrderId: null, updatedAt: now() }, { merge: true })
    }
    return true
  })
}
