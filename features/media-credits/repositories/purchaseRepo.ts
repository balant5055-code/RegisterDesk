// MC-04 · Purchase + reconciliation Firestore I/O — SERVER ONLY.
//
// NO BUSINESS LOGIC. This file knows how a purchase is stored and nothing about what makes
// one valid, what it costs, or when it may change state. Every rule of that kind lives in
// purchaseService.ts. The split is what keeps the pricing rule un-duplicated: a repository
// that "helpfully" defaulted an amount would become a second place prices come from.
//
// ═══ DOCUMENT ID ═════════════════════════════════════════════════════════════
// A purchase is keyed by its own generated `purchaseId`, NOT by the Razorpay order id.
// The order id is stored and indexed instead, because the order does not exist yet at the
// moment we need an id, and because a purchase that fails before an order is created still
// deserves a record.

import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_PURCHASES, MEDIA_CREDIT_RECONCILIATIONS, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditPurchaseDoc, type CreditPurchaseStatus, type CreditReconciliationDoc,
} from '@/features/media-credits/types'

const purchases       = () => adminDb.collection(MEDIA_CREDIT_PURCHASES)
const reconciliations = () => adminDb.collection(MEDIA_CREDIT_RECONCILIATIONS)

export function newPurchaseId(): string {
  return purchases().doc().id
}

// ─── Purchases ────────────────────────────────────────────────────────────────

export interface CreatePurchaseInput {
  purchaseId:                string
  organizerUid:              string
  credits:                   number
  amountPaise:               number
  unitPricePaise:            number
  creditsPerPhotoAtPurchase: number
  tierAtPurchase:            string | null
  gatewayOrderId:            string
}

/**
 * Writes the pending purchase intent.
 *
 * `create`, not `set`: a duplicate purchaseId must be an error, not a silent overwrite of a
 * record that may already have been paid.
 */
export async function createPending(input: CreatePurchaseInput): Promise<CreditPurchaseDoc> {
  const doc: CreditPurchaseDoc = {
    purchaseId:    input.purchaseId,
    schemaVersion: MEDIA_CREDIT_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    credits:       input.credits,
    amountPaise:   input.amountPaise,
    unitPricePaise: input.unitPricePaise,
    creditsPerPhotoAtPurchase: input.creditsPerPhotoAtPurchase,
    currency:      'INR',
    // MC-05. Every purchase this module can create is a Razorpay order; recorded so refund
    // routing switches on stored fact rather than an assumption.
    source:        'razorpay',
    status:        'pending',
    gatewayOrderId:   input.gatewayOrderId,
    gatewayPaymentId: null,
    tierAtPurchase:   input.tierAtPurchase,
    createdAt:     FieldValue.serverTimestamp(),
    updatedAt:     FieldValue.serverTimestamp(),
    grantedAt:     null,
    failureReason: null,
  }
  await purchases().doc(input.purchaseId).create(doc)
  return doc
}

export async function read(purchaseId: string): Promise<CreditPurchaseDoc | null> {
  const snap = await purchases().doc(purchaseId).get()
  return snap.exists ? (snap.data() as CreditPurchaseDoc) : null
}

export async function readInTx(
  tx: Transaction, purchaseId: string,
): Promise<CreditPurchaseDoc | null> {
  const snap = await tx.get(purchases().doc(purchaseId))
  return snap.exists ? (snap.data() as CreditPurchaseDoc) : null
}

/** Finds the purchase a Razorpay order belongs to. Requires the gatewayOrderId index. */
export async function findByOrderId(gatewayOrderId: string): Promise<CreditPurchaseDoc | null> {
  const snap = await purchases()
    .where('gatewayOrderId', '==', gatewayOrderId)
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as CreditPurchaseDoc)
}

/**
 * Marks a purchase granted, INSIDE the caller's transaction.
 *
 * `grantedAt` is written here and never anywhere else, so the timestamp always belongs to
 * the transaction that actually moved the credits.
 */
export function markGrantedInTx(
  tx: Transaction, purchaseId: string, gatewayPaymentId: string, credits: number,
): void {
  tx.update(purchases().doc(purchaseId), {
    status:           'granted' satisfies CreditPurchaseStatus,
    gatewayPaymentId,
    grantedAt:        FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),

    // RD-MC-REFUND-V2-P1 · the lot opens in the SAME write that makes the credits spendable.
    // Any gap between the two would be a window in which the wallet holds credits no lot
    // accounts for, which the invariant would then report as drift.
    //
    // `credits` is passed rather than read back: this function is a pure write by design (it
    // runs after `creditInTx`, and Firestore forbids a read after a write), and both callers
    // already hold the number.
    creditsRemaining: Math.max(0, Math.trunc(credits)),
    // Epoch millis, not a server timestamp: FIFO compares this against grant lots from a
    // different collection, and one numeric scale keeps that comparison in the pure allocator
    // instead of spreading Timestamp handling through it. Millisecond skew between servers
    // cannot misorder two lots a human would call ordered, and exact ties break on lotId.
    lotSeq:           Date.now(),
  })
}

/**
 * Records a terminal or parked outcome outside any transaction.
 *
 * Used for `failed` (verification rejected the payment) and for `paid` (money captured,
 * grant transaction failed). Never used for `granted` — that transition is transactional.
 */
export async function markOutcome(
  purchaseId: string,
  status: Extract<CreditPurchaseStatus, 'paid' | 'failed'>,
  fields: { gatewayPaymentId?: string | null; failureReason?: string | null } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status, updatedAt: FieldValue.serverTimestamp() }
  if (fields.gatewayPaymentId !== undefined) patch.gatewayPaymentId = fields.gatewayPaymentId
  if (fields.failureReason   !== undefined) patch.failureReason   = fields.failureReason
  await purchases().doc(purchaseId).update(patch)
}

/**
 * One page of an organizer's purchases, newest first.
 *
 * The cursor is tenant-checked before use: a caller who guesses another workspace's
 * purchaseId must not be able to page from it. Same guard as `ledgerRepo.listByOrganizer`.
 */
export async function listByOrganizer(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<CreditPurchaseDoc[]> {
  let q = purchases()
    .where('organizerUid', '==', organizerUid)
    .orderBy('createdAt', 'desc')
    .limit(limit)

  if (cursor) {
    const after = await purchases().doc(cursor).get()
    if (after.exists && (after.data() as CreditPurchaseDoc).organizerUid === organizerUid) {
      q = q.startAfter(after)
    }
  }
  const snap = await q.get()
  return snap.docs.map(d => d.data() as CreditPurchaseDoc)
}

// ─── Reconciliations ──────────────────────────────────────────────────────────

export interface RecordReconciliationInput {
  gatewayOrderId:   string
  organizerUid:     string
  purchaseId:       string
  gatewayPaymentId: string
  credits:          number
  amountPaise:      number
  lastError:        string
}

/**
 * Records — or re-records — a captured payment whose grant failed.
 *
 * Keyed by order id and merged, so a client that retries verification three times leaves ONE
 * claim with `attempts: 3`, not three claims that look like three debts.
 */
export async function recordReconciliation(input: RecordReconciliationInput): Promise<void> {
  const ref = reconciliations().doc(input.gatewayOrderId)
  await ref.set({
    gatewayOrderId:   input.gatewayOrderId,
    schemaVersion:    MEDIA_CREDIT_SCHEMA_VERSION,
    organizerUid:     input.organizerUid,
    purchaseId:       input.purchaseId,
    gatewayPaymentId: input.gatewayPaymentId,
    credits:          input.credits,
    amountPaise:      input.amountPaise,
    status:           'pending',
    attempts:         FieldValue.increment(1),
    lastError:        input.lastError.slice(0, 500),
    createdAt:        FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
    resolvedAt:       null,
  }, { merge: true })
}

/**
 * Platform-wide purchases in one status. For the reconciler's orphan sweep.
 *
 * NOT tenant-scoped — the caller must already be the scheduler or a platform admin. No
 * organizer-facing route reaches this.
 */
export async function listByStatus(
  status: CreditPurchaseStatus, limit: number,
): Promise<CreditPurchaseDoc[]> {
  const snap = await purchases().where('status', '==', status).limit(limit).get()
  return snap.docs.map(d => d.data() as CreditPurchaseDoc)
}

export async function listPendingReconciliations(limit: number): Promise<CreditReconciliationDoc[]> {
  const snap = await reconciliations()
    .where('status', '==', 'pending')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditReconciliationDoc)
}

export async function markReconciled(gatewayOrderId: string): Promise<void> {
  await reconciliations().doc(gatewayOrderId).update({
    status:     'resolved',
    updatedAt:  FieldValue.serverTimestamp(),
    resolvedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * MC-08 · A bounded page of purchases across every workspace, for platform revenue totals.
 *
 * ADMIN-ONLY BY CALLER, and bounded for the same reason as `walletRepo.listAll`: revenue is a
 * sum, sums need documents, and an unbounded read of every purchase ever made does not stay
 * fast. `truncated` tells the caller the figure is a floor rather than a total.
 */
export async function listAllPurchases(limit: number): Promise<{
  purchases: CreditPurchaseDoc[]
  truncated: boolean
}> {
  const snap = await purchases().limit(limit + 1).get()
  return {
    purchases: snap.docs.slice(0, limit).map(d => d.data() as CreditPurchaseDoc),
    truncated: snap.size > limit,
  }
}
