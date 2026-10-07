// lib/wallet/topupReview.ts
// RD-WALLET-W2.f — Super Admin review of HELD wallet top-ups. Server-only.
//
// A held top-up is a walletTopupReconciliation record the automated paths will never settle:
//   • '{orderId}'          — the order's own record: 'needs_review' (a refusal, a late payment on an
//                            abandoned order, a payment that did not verify) or 'exhausted' (W2.a);
//   • 'dup_{paymentId}'    — a captured payment on an order credited with ANOTHER payment
//                            ('duplicate_payment'), or one of several captures the sweep held
//                            ('needs_review', reason 'multiple_captured_payments');
//   • 'mismatch_{paymentId}' — a captured payment whose amount / currency does not match (W2.b).
// While any of them is open, the top-up guard refuses the organizer a new top-up.
//
// Two decisions, both Super Admin only (the route enforces requireSuperAdmin), both with a
// mandatory 3–500 character reason, both ONE transaction with the audit row staged in it:
//   credit  — ONLY after the exact payment is re-verified at the gateway NOW (captured, this order,
//             this amount, INR, nothing refunded), and only through creditTopupUnderReview: the same
//             wallet, the same create-only `topup_<orderId>` ledger row, never a second credit.
//   resolve — closes the record WITHOUT credit. A duplicate captured payment additionally requires
//             the EXTERNAL refund reference (refunds happen at the gateway, never in-app).
// Every decision is idempotent: only a record still in a held status is decided — a repeat, or a
// race with another reviewer, is a 409 and changes nothing.
//
// Unblocking (approved requirement 6): a resolved record is no longer open, so the guard's record
// check passes. An order frozen for review ('needs_review') is marked `holdResolvedAt` once none of
// its records is open any more; the guard skips such an order. A resolved-without-credit order that
// was still 'pending' is frozen to 'needs_review' in the same commit, so no automated path (webhook,
// verify, retry, sweep) can credit it afterwards.
//
// Not here, by design: refunds of any kind, a new balance or ledger, and any live W2.d evidence
// provider. The only gateway call is the Razorpay payment lookup the retry cron already makes.

import { FieldValue, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { creditTopupUnderReview, REVIEW_CREDITABLE_TOPUP_STATUSES, TopupCreditError } from '@/lib/firebase/firestore/wallet'
import { stageAdminAudit } from '@/lib/admin/audit'

const COLLECTION = 'walletTopupReconciliation'

/** Statuses a Super Admin can decide. 'pending' is not here: the retry cron still owns it. */
export const REVIEWABLE_STATUSES = ['needs_review', 'exhausted', 'duplicate_payment'] as const
const REVIEWABLE: ReadonlySet<string> = new Set(REVIEWABLE_STATUSES)
/** Statuses that keep the organizer blocked (lib/wallet/topupGuard.ts OPEN_RECONCILIATION). */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['pending', 'needs_review', 'exhausted', 'duplicate_payment'])

const RECORD_ID  = /^[A-Za-z0-9_.:-]{1,160}$/
const REFUND_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,99}$/
export const GATEWAY_LOOKUP_TIMEOUT_MS = 8_000

export class TopupReviewError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:   string,
    message:                string,
    public readonly detail?: Record<string, string | number | boolean | null>,
  ) {
    super(message)
    this.name = 'TopupReviewError'
  }
}

type Rec = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const iso = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export const isReviewRecordId = (v: unknown): v is string => typeof v === 'string' && RECORD_ID.test(v)

// ── pure rules ─────────────────────────────────────────────────────────────────────────────────
export type HeldRecordKind = 'order' | 'duplicate' | 'mismatch'

export function heldRecordKind(recordId: string): HeldRecordKind {
  if (recordId.startsWith('dup_')) return 'duplicate'
  if (recordId.startsWith('mismatch_')) return 'mismatch'
  return 'order'
}

/**
 * Pure. A DUPLICATE captured payment — approved: its resolution requires the external refund
 * reference. A recorded duplicate, one of several captures held together, or the order's own
 * payment when the order was credited with a different one. (A mismatched payment is its own case:
 * the reference is recorded when given, not required.)
 */
export function requiresRefundReference(recordId: string, rec: Rec, topup: Rec | null): boolean {
  if (rec.status === 'duplicate_payment' || rec.reason === 'multiple_captured_payments') return true
  if (heldRecordKind(recordId) === 'mismatch') return false
  return topup?.status === 'credited' && typeof topup.paymentId === 'string' && topup.paymentId !== rec.paymentId
}

export type RefundReferenceResult =
  | { ok: true; value: string | null }
  | { ok: false; code: 'REFUND_REFERENCE_INVALID'; error: string }

/** Pure. The external refund reference (e.g. a Razorpay `rfnd_…` id or a bank reference); blank → null. */
export function parseRefundReference(v: unknown): RefundReferenceResult {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null }
  const s = typeof v === 'string' ? v.trim() : ''
  if (!REFUND_REF.test(s)) {
    return { ok: false, code: 'REFUND_REFERENCE_INVALID', error: 'The refund reference must be 3–100 characters: letters, digits and _ . : / - only.' }
  }
  return { ok: true, value: s }
}

export interface GatewayCreditEvidence {
  paymentId: string; orderId: string; amountPaise: number; currency: 'INR'; status: 'captured'; amountRefundedPaise: 0
}
export type GatewayCreditCheck =
  | { ok: true; evidence: GatewayCreditEvidence }
  | { ok: false; reason: string }

/**
 * Pure. Does the RAW gateway payment prove the exact credit? Captured, this payment id, this order,
 * exactly this amount, INR, and nothing refunded. Anything missing or unexpected refuses — the raw
 * response is used because the provider adapter defaults a missing currency / amount (W2.c).
 */
export function checkPaymentForReviewedCredit(raw: unknown, expect: { paymentId: string; orderId: string; amountPaise: number }): GatewayCreditCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'gateway_response_malformed' }
  const p = raw as Rec
  if (p.id !== expect.paymentId) return { ok: false, reason: 'payment_id_differs' }
  if (p.order_id !== expect.orderId) return { ok: false, reason: 'order_mismatch' }
  if (p.status !== 'captured') return { ok: false, reason: `not_captured:${typeof p.status === 'string' ? p.status : 'unknown'}` }
  if (p.currency !== 'INR') return { ok: false, reason: 'currency_mismatch' }
  if (!isPosInt(p.amount) || p.amount !== expect.amountPaise) return { ok: false, reason: 'amount_mismatch' }
  if (typeof p.amount_refunded !== 'number') return { ok: false, reason: 'refund_state_unknown' }
  if (p.amount_refunded !== 0 || (p.refund_status !== undefined && p.refund_status !== null)) return { ok: false, reason: 'refunded_at_gateway' }
  return { ok: true, evidence: { paymentId: expect.paymentId, orderId: expect.orderId, amountPaise: expect.amountPaise, currency: 'INR', status: 'captured', amountRefundedPaise: 0 } }
}

// ── gateway (the existing Razorpay payment lookup; read-only) ──────────────────────────────────
async function fetchGatewayPayment(paymentId: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { razorpay } = await import('@/lib/razorpay/client')
    return await Promise.race([
      razorpay.payments.fetch(paymentId) as Promise<unknown>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), GATEWAY_LOOKUP_TIMEOUT_MS) }),
    ])
  } catch {
    throw new TopupReviewError(503, 'GATEWAY_UNAVAILABLE', 'The payment could not be checked at the gateway right now. Nothing was changed — try again shortly.')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── in-transaction reads ───────────────────────────────────────────────────────────────────────
interface HeldRead { rec: Rec; previousStatus: string; otherOpen: string[] }

/** Re-reads the record (still held? same payment?) and the order's OTHER open records — reads only. */
async function readHeld(txn: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference, expectPaymentId?: string): Promise<HeldRead> {
  const snap = await txn.get(ref)
  if (!snap.exists) throw new TopupReviewError(404, 'NOT_FOUND', 'Review record not found.')
  const rec = snap.data() as Rec
  const status = typeof rec.status === 'string' ? rec.status : 'unknown'
  if (!REVIEWABLE.has(status)) {
    throw new TopupReviewError(409, 'NOT_HELD', `Only a held record can be decided (current: '${status}').`, { status })
  }
  if (expectPaymentId !== undefined && rec.paymentId !== expectPaymentId) {
    throw new TopupReviewError(409, 'RECORD_CHANGED', 'The record changed while it was being checked. Reload and try again.')
  }
  const orderId = str(rec.orderId)
  let otherOpen: string[] = []
  if (orderId) {
    const siblings = await txn.get(adminDb.collection(COLLECTION).where('orderId', '==', orderId).limit(100))
    otherOpen = siblings.docs
      .filter(d => d.id !== ref.id && OPEN_STATUSES.has(String((d.data() as Rec).status)))
      .map(d => d.id)
  }
  return { rec, previousStatus: status, otherOpen }
}

// ── credit ─────────────────────────────────────────────────────────────────────────────────────
export interface ReviewCreditOutcome {
  recordId: string; orderId: string; paymentId: string
  outcome: 'credited'; amountPaise: number; newBalancePaise: number
  /** Other records of this order still open (e.g. further duplicate captures to resolve). */
  otherOpenRecords: number
}

export async function creditHeldTopup(input: { adminUid: string; recordId: string; reason: string }): Promise<ReviewCreditOutcome> {
  const { adminUid, recordId, reason } = input
  const ref = adminDb.collection(COLLECTION).doc(recordId)

  // ── checks before the gateway (cheap, and they keep the gateway out of hopeless cases) ──
  const pre = await ref.get()
  if (!pre.exists) throw new TopupReviewError(404, 'NOT_FOUND', 'Review record not found.')
  const rec = pre.data() as Rec
  if (rec.status === 'duplicate_payment') {
    throw new TopupReviewError(409, 'ALREADY_CREDITED', 'This order was already credited with another payment. A duplicate is resolved with its external refund reference, never credited.')
  }
  if (typeof rec.status !== 'string' || !REVIEWABLE.has(rec.status)) {
    throw new TopupReviewError(409, 'NOT_HELD', `Only a held record can be decided (current: '${String(rec.status)}').`)
  }
  const orderId = str(rec.orderId), paymentId = str(rec.paymentId)
  if (!orderId || !paymentId || !isReviewRecordId(orderId) || !isReviewRecordId(paymentId)) {
    throw new TopupReviewError(409, 'RECORD_INCOMPLETE', 'The record has no usable order or payment id, so the payment cannot be verified. Resolve it without credit instead.')
  }
  const topupRef = adminDb.collection('walletTopups').doc(orderId)
  const topupPre = await topupRef.get()
  if (!topupPre.exists) throw new TopupReviewError(409, 'ORDER_NOT_FOUND', 'The top-up order does not exist, so nothing can be credited.')
  const topup = topupPre.data() as Rec
  const uid = str(topup.uid)
  if (!uid || !isPosInt(topup.amountPaise)) throw new TopupReviewError(409, 'ORDER_INCOMPLETE', 'The top-up order has no usable owner or amount.')
  if (topup.status === 'credited') {
    throw new TopupReviewError(409, 'ALREADY_CREDITED', topup.paymentId === paymentId
      ? 'This order is already credited with this payment. Resolve the record without credit.'
      : 'This order is already credited with another payment. Resolve this one as a duplicate with its external refund reference.')
  }
  if (typeof topup.status !== 'string' || !REVIEW_CREDITABLE_TOPUP_STATUSES.has(topup.status)) {
    throw new TopupReviewError(409, 'ORDER_NOT_CREDITABLE', `The order cannot be credited from status '${String(topup.status)}'.`)
  }
  if (rec.uid !== uid) throw new TopupReviewError(409, 'OWNER_MISMATCH', 'The record and the order name different organizers. Nothing can be credited.')
  const amountPaise = topup.amountPaise

  // ── the gateway, NOW: the exact captured payment (never inside the transaction) ──
  const check = checkPaymentForReviewedCredit(await fetchGatewayPayment(paymentId), { paymentId, orderId, amountPaise })
  if (!check.ok) {
    throw new TopupReviewError(409, 'PAYMENT_NOT_VERIFIED', 'The gateway does not confirm this exact captured payment for this order, amount and currency. Nothing was credited.', { why: check.reason })
  }
  const evidence = { ...check.evidence, checkedAt: new Date().toISOString() }

  let otherOpen = 0
  try {
    const r = await creditTopupUnderReview(uid, amountPaise, topupRef, paymentId, { adminUid, recordId }, {
      read: async (txn, topupNow) => {
        const held = await readHeld(txn, ref, paymentId)
        if (held.previousStatus === 'duplicate_payment') throw new TopupReviewError(409, 'ALREADY_CREDITED', 'This order was already credited with another payment.')
        if (topupNow.status === 'credited') throw new TopupReviewError(409, 'ALREADY_CREDITED', 'This order was credited while it was being checked. Nothing more was credited.')
        if (held.rec.uid !== topupNow.uid) throw new TopupReviewError(409, 'OWNER_MISMATCH', 'The record and the order name different organizers.')
        return { ...held, orderStatusBefore: String(topupNow.status) }
      },
      stage: (txn, held, newBalance) => {
        otherOpen = held.otherOpen.length
        const now = FieldValue.serverTimestamp()
        txn.update(ref, {
          status: 'resolved', resolvedAt: now, resolvedBy: adminUid, updatedAt: now, nextAttemptAt: FieldValue.delete(),
          review: { action: 'credited', by: adminUid, at: now, reason, previousStatus: held.previousStatus, evidence },
        })
        stageAdminAudit(txn, {
          adminUid, actorRole: 'super_admin', action: 'wallet_topup.review_credited',
          entityType: 'wallet_topup', entityId: recordId, reason,
          changedFields: ['status', 'review', 'walletTopups.status', 'organizerWallets.balancePaise'],
          before: { recordStatus: held.previousStatus, orderStatus: held.orderStatusBefore }, after: { recordStatus: 'resolved', orderStatus: 'credited', balancePaise: newBalance },
          metadata: { kind: heldRecordKind(recordId), amountPaise, evidence, otherOpenRecords: held.otherOpen },
          correlation: { recordId, orderId, paymentId, uid },
        })
      },
    })
    return { recordId, orderId, paymentId, outcome: 'credited', amountPaise, newBalancePaise: r.newBalance, otherOpenRecords: otherOpen }
  } catch (e) {
    if (e instanceof TopupCreditError) {
      throw new TopupReviewError(409, 'CREDIT_REFUSED', 'The credit was refused by the wallet transaction. Nothing was credited.', { refusal: e.code })
    }
    throw e
  }
}

// ── resolve without credit ─────────────────────────────────────────────────────────────────────
export interface ReviewResolveOutcome {
  recordId: string; orderId: string | null; paymentId: string | null
  outcome: 'resolved_without_credit' | 'duplicate_refunded_externally'
  refundReference: string | null
  /** The order's review hold is closed (no record of the order is open any more). */
  orderHoldResolved: boolean
  otherOpenRecords: number
}

export async function resolveHeldTopup(input: { adminUid: string; recordId: string; reason: string; refundReference: string | null }): Promise<ReviewResolveOutcome> {
  const { adminUid, recordId, reason, refundReference } = input
  const ref = adminDb.collection(COLLECTION).doc(recordId)
  const kind = heldRecordKind(recordId)

  return adminDb.runTransaction(async txn => {
    const held = await readHeld(txn, ref)
    const orderId = str(held.rec.orderId)
    const topupRef = orderId && isReviewRecordId(orderId) ? adminDb.collection('walletTopups').doc(orderId) : null
    const topupSnap = topupRef ? await txn.get(topupRef) : null
    const topup = topupSnap?.exists ? topupSnap.data() as Rec : null

    const duplicate = requiresRefundReference(recordId, held.rec, topup)
    if (duplicate && !refundReference) {
      throw new TopupReviewError(400, 'REFUND_REFERENCE_REQUIRED', 'This is a duplicate captured payment: record the external refund reference before resolving it.')
    }
    const now = FieldValue.serverTimestamp()

    // The order: freeze a still-pending order whose OWN payment is resolved without credit (so no
    // automated path credits it later), and close its review hold once nothing of it is open.
    let orderHoldResolved = false
    let orderAfter: string | null = topup ? String(topup.status) : null
    if (topup && topupRef) {
      const freeze = kind === 'order' && topup.status === 'pending'
      if (freeze || topup.status === 'needs_review') {
        const update: Rec = {}
        if (freeze) Object.assign(update, { status: 'needs_review', holdReason: 'resolved_without_credit', heldAt: now })
        if (held.otherOpen.length === 0) {
          Object.assign(update, { holdResolvedAt: now, holdResolvedBy: adminUid, holdResolvedRecordId: recordId })
          orderHoldResolved = true
        }
        if (Object.keys(update).length > 0) {
          txn.update(topupRef, { ...update, updatedAt: now })
          orderAfter = 'needs_review'
        }
      }
    }

    const outcome = duplicate ? 'duplicate_refunded_externally' as const : 'resolved_without_credit' as const
    txn.update(ref, {
      status: 'resolved', resolvedAt: now, resolvedBy: adminUid, updatedAt: now, nextAttemptAt: FieldValue.delete(),
      review: { action: outcome, by: adminUid, at: now, reason, previousStatus: held.previousStatus, refundReference },
    })
    stageAdminAudit(txn, {
      adminUid, actorRole: 'super_admin', action: 'wallet_topup.review_resolved',
      entityType: 'wallet_topup', entityId: recordId, reason,
      changedFields: ['status', 'review', ...(orderAfter !== (topup ? String(topup.status) : null) || orderHoldResolved ? ['walletTopups.hold'] : [])],
      before: { recordStatus: held.previousStatus, orderStatus: topup ? String(topup.status) : null },
      after:  { recordStatus: 'resolved', orderStatus: orderAfter, orderHoldResolved },
      metadata: { kind, outcome, refundReference, amountPaise: isPosInt(held.rec.amountPaise) ? held.rec.amountPaise : null, otherOpenRecords: held.otherOpen },
      correlation: { recordId, orderId, paymentId: str(held.rec.paymentId), refundReference, uid: str(held.rec.uid) },
    })
    return {
      recordId, orderId, paymentId: str(held.rec.paymentId), outcome, refundReference,
      orderHoldResolved, otherOpenRecords: held.otherOpen.length,
    }
  })
}

// ── the review list (Super Admin console) ──────────────────────────────────────────────────────
export interface HeldTopupRow {
  recordId:     string
  kind:         HeldRecordKind
  status:       string
  reason:       string | null
  lastError:    string | null
  orderId:      string | null
  paymentId:    string | null
  uid:          string | null
  organizerName: string | null
  amountPaise:  number | null
  orderStatus:  string | null
  orderPaymentId: string | null
  attempts:     number | null
  firstSeenAt:  string | null
  /** Advisory for the console — the server re-checks everything when a decision is made. */
  creditPossible:          boolean
  refundReferenceRequired: boolean
}

export async function listHeldTopupRecords(opts: { cursor?: string | null; limit?: number } = {}): Promise<{ rows: HeldTopupRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 25)))
  let q = adminDb.collection(COLLECTION)
    .where('status', 'in', [...REVIEWABLE_STATUSES])
    .orderBy(FieldPath.documentId())
    .limit(limit + 1) as FirebaseFirestore.Query
  if (opts.cursor && isReviewRecordId(opts.cursor)) q = q.startAfter(opts.cursor)
  const snap = await q.get()
  const docs = snap.docs.slice(0, limit)
  const nextCursor = snap.docs.length > limit ? docs[docs.length - 1].id : null

  const orderIds = docs.map(d => str((d.data() as Rec).orderId))
  const uids     = docs.map(d => str((d.data() as Rec).uid))
  const [topups, users] = await Promise.all([
    orderIds.some(Boolean) ? adminDb.getAll(...orderIds.map(id => adminDb.collection('walletTopups').doc(id && isReviewRecordId(id) ? id : '__none__'))) : Promise.resolve([]),
    uids.some(Boolean) ? adminDb.getAll(...uids.map(id => adminDb.collection('users').doc(id && isReviewRecordId(id) ? id : '__none__'))) : Promise.resolve([]),
  ])
  const rows = docs.map((d, i): HeldTopupRow => {
    const r = d.data() as Rec
    const t = topups[i]?.exists ? topups[i].data() as Rec : null
    const u = users[i]?.exists ? users[i].data() as Rec : null
    const status = String(r.status)
    return {
      recordId: d.id, kind: heldRecordKind(d.id), status,
      reason: str(r.reason), lastError: str(r.lastError),
      orderId: str(r.orderId), paymentId: str(r.paymentId), uid: str(r.uid),
      organizerName: u ? str(u.name) : null,
      amountPaise: isPosInt(r.amountPaise) ? r.amountPaise : null,
      orderStatus: t ? str(t.status) : null, orderPaymentId: t ? str(t.paymentId) : null,
      attempts: typeof r.attempts === 'number' ? r.attempts : null,
      firstSeenAt: iso(r.firstSeenAt),
      creditPossible: status !== 'duplicate_payment' && !!t && typeof t.status === 'string'
        && REVIEW_CREDITABLE_TOPUP_STATUSES.has(t.status) && t.uid === r.uid && !!str(r.paymentId),
      refundReferenceRequired: requiresRefundReference(d.id, r, t),
    }
  })
  return { rows, nextCursor }
}
