// MC-05 · Refund Firestore I/O — SERVER ONLY.
//
// NO BUSINESS LOGIC. This file knows how a refund is stored; it knows nothing about who may
// request one, whether credits are available, or what a service charge is. Those live in
// refundService.ts.

import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  CREDIT_REFUND_BLOCKING_STATUSES,
  MEDIA_CREDIT_REFUNDS, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditRefundDoc, type CreditRefundStatus,
} from '@/features/media-credits/types'

const refunds = () => adminDb.collection(MEDIA_CREDIT_REFUNDS)

export function newRefundId(): string {
  return refunds().doc().id
}

export type CreateRefundInput = Omit<
  CreditRefundDoc,
  'schemaVersion' | 'status' | 'decidedBy' | 'decisionNote'
  | 'gatewayRefundId' | 'gatewayResponse' | 'gatewayError' | 'gatewayAttempts'
  | 'settlingSince'
  | 'createdAt' | 'updatedAt' | 'decidedAt' | 'settledAt'
>

/** The stored shape of a brand-new request. One definition, used by both writers below. */
function requestedDoc(input: CreateRefundInput): CreditRefundDoc {
  return {
    ...input,
    schemaVersion:   MEDIA_CREDIT_SCHEMA_VERSION,
    status:          'requested',
    decidedBy:       null,
    decisionNote:    null,
    gatewayRefundId: null,
    gatewayResponse: null,
    gatewayError:    null,
    gatewayAttempts: 0,
    settlingSince:   null,
    createdAt:       FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
    decidedAt:       null,
    settledAt:       null,
  }
}

/** `create`, not `set` — a duplicate refundId must fail rather than overwrite a decision. */
export async function createRequested(input: CreateRefundInput): Promise<CreditRefundDoc> {
  const doc = requestedDoc(input)
  await refunds().doc(input.refundId).create(doc)
  return doc
}

/**
 * RD-MC-REFUND-V2-P3 · the same write, INSIDE the caller's transaction.
 *
 * A refund now places a wallet hold, and the request and the hold must commit together or not
 * at all: a request without its hold reserves nothing, and a hold without its request is
 * credits locked by a document that does not exist. Neither is recoverable by a later sweep,
 * because nothing would know it had happened.
 *
 * Still `tx.create`, so the race-safety of the non-transactional version is unchanged.
 * Pure write — must follow every read in the caller's transaction.
 */
export function createRequestedInTx(
  tx: Transaction, input: CreateRefundInput,
): CreditRefundDoc {
  const doc = requestedDoc(input)
  tx.create(refunds().doc(input.refundId), doc)
  return doc
}

export async function read(refundId: string): Promise<CreditRefundDoc | null> {
  const snap = await refunds().doc(refundId).get()
  return snap.exists ? (snap.data() as CreditRefundDoc) : null
}

export async function readInTx(
  tx: Transaction, refundId: string,
): Promise<CreditRefundDoc | null> {
  const snap = await tx.get(refunds().doc(refundId))
  return snap.exists ? (snap.data() as CreditRefundDoc) : null
}

/**
 * Any refund for this purchase that is not a dead end.
 *
 * `requested`, `approved` and `settling` all block a new request: the first is queued, the
 * second has already debited the credits, the third is mid-payout. Only `rejected` frees the
 * purchase to be asked about again; `settled` means it is gone for good and the
 * purchase-status check catches that separately.
 */
export async function findBlockingForPurchase(purchaseId: string): Promise<CreditRefundDoc | null> {
  const snap = await refunds()
    .where('purchaseId', '==', purchaseId)
    // RD-MC-REFUND-V2-P3 · ACTIVE refunds only. `settled` was removed: a settled partial
    // refund leaves the rest of the purchase refundable, and blocking on it made the first
    // partial refund the last one. Over-refunding is prevented by `creditsRemaining`, which
    // the approval drains — not by this query.
    .where('status', 'in', [...CREDIT_REFUND_BLOCKING_STATUSES])
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as CreditRefundDoc)
}

/**
 * RD-MC-REFUND-V2-P3 · the same blocking check, INSIDE the caller's transaction.
 *
 * The non-transactional version above is a fast pre-check. This one is the guard: two
 * simultaneous requests for the same purchase would both pass the pre-check, and without a
 * transactional re-read both would place a hold — the "never double hold" rule broken by a
 * race that a status field alone cannot see.
 *
 * MUST be called before the caller's first write.
 */
export async function findBlockingForPurchaseInTx(
  tx: Transaction, purchaseId: string,
): Promise<CreditRefundDoc | null> {
  const snap = await tx.get(refunds()
    .where('purchaseId', '==', purchaseId)
    .where('status', 'in', [...CREDIT_REFUND_BLOCKING_STATUSES])
    .limit(1))
  return snap.empty ? null : (snap.docs[0].data() as CreditRefundDoc)
}

/**
 * RD-MC-REFUND-V2-P3 · has this purchase ever been refunded to completion?
 *
 * Separate from the blocking query on purpose. A fully-refunded purchase has no credits left,
 * and `no_unused_credits` would describe that as "every credit has been used" — false, and
 * the organizer would go looking for uploads that never happened. This answers "or were they
 * refunded", so the reason can say so.
 */
export async function hasSettledRefund(purchaseId: string): Promise<boolean> {
  const snap = await refunds()
    .where('purchaseId', '==', purchaseId)
    .where('status', '==', 'settled')
    .limit(1)
    .get()
  return !snap.empty
}

/** Marks the decision inside the caller's transaction. Pure write — must follow every read. */
export function decideInTx(
  tx: Transaction,
  refundId: string,
  // RD-MC-REFUND-V2-P3 · `cancelled` joins the decisions. `decidedBy` then holds the
  // organizer's uid rather than an admin's, which is exactly the record wanted: whoever
  // ended the request is named on it.
  status: Extract<CreditRefundStatus, 'approved' | 'rejected' | 'cancelled'>,
  decidedBy: string,
  decisionNote: string | null,
): void {
  tx.update(refunds().doc(refundId), {
    status, decidedBy, decisionNote,
    decidedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

// ─── The claim (MC-05.6A) ─────────────────────────────────────────────────────

/**
 * How long a `settling` claim is honoured before it is treated as abandoned.
 *
 * Far longer than any gateway call needs (a Razorpay refund returns in seconds) so a claim
 * is never stolen from a caller that is still working — which would reintroduce the very
 * double-refund this exists to prevent. Short enough that a crashed holder is retried
 * within one scheduler cycle or two.
 */
export const SETTLING_CLAIM_TTL_MS = 10 * 60 * 1000

export type ClaimOutcome =
  | { claimed: true;  refund: CreditRefundDoc }
  /** Someone else holds a live claim, or the refund is not in a claimable state. */
  | { claimed: false; reason: 'already_settled' | 'in_progress' | 'not_approved'
      refund: CreditRefundDoc | null }

/**
 * THE atomic claim. Moves `approved → settling` for exactly one caller.
 *
 * This is the whole fix for the duplicate-refund race. Firestore serialises transactions on
 * a document, so of N concurrent callers exactly one observes a claimable state and writes
 * the claim; every other one observes `settling` (or `settled`) and is told to stand down.
 * The gateway is only ever reached by the winner.
 *
 * Modelled directly on `app/api/admin/failed-refunds/[id]/retry/route.ts`, which claims
 * `open → retrying` before calling Razorpay for exactly this reason.
 *
 * A STALE claim is re-takeable: if the holder crashed between claiming and settling, the row
 * would otherwise be stranded forever. Re-taking is safe because `refundPayment` asks the
 * gateway whether a refund tagged with this refundId already exists and adopts it rather
 * than creating a second — so even a claim re-taken while a zombie call is somehow still in
 * flight cannot produce two payouts.
 */
export async function claimForSettlement(refundId: string): Promise<ClaimOutcome> {
  const ref = refunds().doc(refundId)
  return adminDb.runTransaction<ClaimOutcome>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { claimed: false, reason: 'not_approved', refund: null }

    const refund = snap.data() as CreditRefundDoc

    if (refund.status === 'settled') {
      return { claimed: false, reason: 'already_settled', refund }
    }

    if (refund.status === 'settling') {
      const since = refund.settlingSince as { toMillis?: () => number } | null
      const sinceMs = typeof since?.toMillis === 'function' ? since.toMillis() : 0
      // `sinceMs === 0` means the timestamp is unreadable — treat the claim as stale rather
      // than as live, or an unparseable value would strand the refund permanently.
      const live = sinceMs > 0 && Date.now() - sinceMs < SETTLING_CLAIM_TTL_MS
      if (live) return { claimed: false, reason: 'in_progress', refund }
      // Stale: the previous holder is gone. Re-take it by refreshing the claim stamp.
      tx.update(ref, {
        settlingSince: FieldValue.serverTimestamp(),
        updatedAt:     FieldValue.serverTimestamp(),
      })
      return { claimed: true, refund }
    }

    if (refund.status !== 'approved') {
      return { claimed: false, reason: 'not_approved', refund }
    }

    tx.update(ref, {
      status:        'settling' satisfies CreditRefundStatus,
      settlingSince: FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    })
    return { claimed: true, refund }
  })
}

/**
 * Returns a claimed refund to the retry state after a failed gateway call.
 *
 * `settling → approved`, clearing the claim stamp so the reconciler picks it up immediately
 * rather than waiting out the TTL. The attempt counter is incremented here — it counts
 * gateway attempts, and this is the only path a failed one takes.
 */
export async function releaseClaim(refundId: string, error: string): Promise<void> {
  await refunds().doc(refundId).update({
    status:          'approved' satisfies CreditRefundStatus,
    settlingSince:   null,
    gatewayError:    error.slice(0, 500),
    gatewayAttempts: FieldValue.increment(1),
    updatedAt:       FieldValue.serverTimestamp(),
  })
}

/**
 * Claims abandoned by a crashed holder — `settling` older than the TTL.
 *
 * Deliberately excludes fresh claims, so the scheduler cannot interrupt a settlement that is
 * still running.
 */
export async function listStaleSettling(limit: number): Promise<CreditRefundDoc[]> {
  const cutoff = Timestamp.fromMillis(Date.now() - SETTLING_CLAIM_TTL_MS)
  const snap = await refunds()
    .where('status', '==', 'settling')
    .where('settlingSince', '<=', cutoff)
    .orderBy('settlingSince', 'asc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditRefundDoc)
}

/** Records a successful gateway payout. The only transition into a terminal money state. */
export async function markSettled(
  refundId: string, gatewayRefundId: string, gatewayResponse: Record<string, unknown>,
): Promise<void> {
  await refunds().doc(refundId).update({
    status:     'settled' satisfies CreditRefundStatus,
    gatewayRefundId, gatewayResponse,
    gatewayError: null,
    // The claim is released by reaching the terminal state, not left dangling.
    settlingSince: null,
    settledAt:  FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })
}

// `recordGatewayFailure` was removed in MC-05.6A. It recorded an error WITHOUT changing
// status, which was correct when a failed payout left the refund `approved` — but under the
// claim a failed payout is holding `settling`, and a method that logs the error without
// releasing the claim would strand the refund until the TTL expired. `releaseClaim` does
// both, and is the only path a failed gateway attempt takes.

async function page(
  q: FirebaseFirestore.Query, limit: number, cursor?: string | null,
): Promise<CreditRefundDoc[]> {
  let query = q.orderBy('createdAt', 'desc').limit(limit)
  if (cursor) {
    const after = await refunds().doc(cursor).get()
    if (after.exists) query = query.startAfter(after)
  }
  const snap = await query.get()
  return snap.docs.map(d => d.data() as CreditRefundDoc)
}

/** One organizer's refunds, newest first. The cursor is tenant-checked by the caller's query. */
export async function listByOrganizer(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<CreditRefundDoc[]> {
  return page(refunds().where('organizerUid', '==', organizerUid), limit, cursor)
}

/** Platform-wide queue for admin review. */
export async function listByStatus(
  status: CreditRefundStatus, limit: number, cursor?: string | null,
): Promise<CreditRefundDoc[]> {
  return page(refunds().where('status', '==', status), limit, cursor)
}
