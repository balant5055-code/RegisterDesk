// Server-side wallet helpers — Admin SDK only, never imported by client code.

import { FieldValue }   from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import type { OrganizerWallet } from '@/types/events'

const walletRef = (uid: string) => adminDb.doc(`organizerWallets/${uid}`)

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getWalletBalance(uid: string): Promise<number> {
  const snap = await walletRef(uid).get()
  if (!snap.exists) return 0
  return (snap.data() as OrganizerWallet).balancePaise ?? 0
}

// ─── Write (must be called inside a Firestore transaction) ────────────────────

export function txnDeductWallet(
  txn:         FirebaseFirestore.Transaction,
  uid:         string,
  amountPaise: number,
): void {
  txn.set(walletRef(uid), {
    balancePaise: FieldValue.increment(-amountPaise),
    currency:     'INR',
    updatedAt:    FieldValue.serverTimestamp(),
  }, { merge: true })
}

// ─── Idempotent credit + ledger (for non-topup credits, e.g. license refunds) ──

/**
 * Atomically credits the wallet AND writes an idempotent ledger entry in ONE
 * transaction, keyed by the caller-supplied deterministic `ledgerRef`. If that
 * ledger doc already exists the credit is a no-op (`credited: false`), so a
 * concurrent second call or a crash-retry can never double-credit and the balance
 * can never drift from Σ(ledger). Mirrors atomicTopupCredit for credits that don't
 * originate from a walletTopups doc. The helper stamps `amountPaise`, the running
 * `balancePaise`, and `createdAt` — the caller supplies the rest of the entry.
 */
export async function atomicWalletCredit(
  uid:         string,
  amountPaise: number,
  ledgerRef:   FirebaseFirestore.DocumentReference,
  ledgerData:  Record<string, unknown>,
): Promise<{ newBalance: number; credited: boolean }> {
  const wRef = walletRef(uid)
  return adminDb.runTransaction(async txn => {
    const [ledgerSnap, walletSnap] = await Promise.all([txn.get(ledgerRef), txn.get(wRef)])
    const current = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    if (ledgerSnap.exists) return { newBalance: current, credited: false }   // idempotent — no writes
    const updated = current + amountPaise
    txn.set(wRef, {
      balancePaise: updated,
      currency:     'INR',
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true })
    txn.set(ledgerRef, {
      ...ledgerData,
      amountPaise,
      balancePaise: updated,
      createdAt:    FieldValue.serverTimestamp(),
    })
    return { newBalance: updated, credited: true }
  })
}

// ─── Top-up (called only after a CAPTURED Razorpay payment was verified) ─────
//
// RD-WALLET-W1 — the legacy `creditWallet` (a non-idempotent credit that wrote no ledger
// entry and had no callers) was removed. Every wallet credit goes through an idempotent,
// ledger-writing transaction: atomicTopupCredit (top-ups) or atomicWalletCredit (others).

/**
 * A top-up that must NOT be credited — thrown, never silently skipped, so the caller can
 * refuse, flag or hold it for review. None of these is a transient error: retrying cannot
 * make them creditable.
 */
export type TopupCreditRefusal =
  | 'TOPUP_NOT_FOUND'         // no walletTopups/{orderId} — an unknown or unverifiable order
  | 'TOPUP_OWNER_MISMATCH'    // the caller's uid is not the order's owner
  | 'TOPUP_AMOUNT_MISMATCH'   // the amount to credit is not the order's stored amount
  | 'TOPUP_NOT_CREDITABLE'    // status is neither 'pending' nor 'credited'
  | 'TOPUP_LEDGER_CONFLICT'   // a ledger row exists but the order is not marked credited
  | 'TOPUP_REVIEW_HOLD'       // RD-WALLET-W2.c — the order is under an order-level review hold (needs_review / exhausted)

export class TopupCreditError extends Error {
  constructor(public readonly code: TopupCreditRefusal) {
    super(code)
    this.name = 'TopupCreditError'
  }
}

export interface TopupCreditResult {
  newBalance: number
  /** True only on the commit that actually credited the wallet. */
  credited:   boolean
  /**
   * When the order was ALREADY credited: the payment it was credited with. A caller holding a
   * DIFFERENT captured payment id for the same order has found a duplicate payment (W1.4).
   */
  creditedPaymentId?: string | null
}

// Atomically credits the wallet, marks the topup 'credited', AND writes the immutable
// wallet-transaction ledger entry — all in ONE transaction (audit C-1). Exactly-once: the
// order's status and the deterministic ledger id (`topup_<orderId>`) are both read inside the
// transaction, and the ledger row is CREATED (never overwritten). The verify route, the
// payment.captured webhook and the reconciliation cron all converge here.
//
// RD-WALLET-W1 — it now refuses (TopupCreditError) instead of crediting anything it cannot
// tie to a real, pending order of the same owner and amount. It never checks the payment's
// capture state itself: every caller must have verified a CAPTURED payment first.
//
// orderId is taken from topupRef.id (walletTopups is keyed by Razorpay order id).
export async function atomicTopupCredit(
  uid:         string,
  amountPaise: number,
  topupRef:    FirebaseFirestore.DocumentReference,
  paymentId:   string,
): Promise<TopupCreditResult> {
  const wRef      = walletRef(uid)
  const orderId   = topupRef.id
  const ledgerRef = adminDb.collection('walletTransactions').doc(`topup_${orderId}`)
  // RD-WALLET-W2.c — the order's own reconciliation record. Read INSIDE the transaction so a hold
  // committed concurrently makes this credit retry and see it (no race with the hold's writer).
  const holdRef   = adminDb.collection('walletTopupReconciliation').doc(orderId)

  return adminDb.runTransaction(async txn => {
    const [topupSnap, walletSnap, ledgerSnap, holdSnap] = await Promise.all([
      txn.get(topupRef),
      txn.get(wRef),
      txn.get(ledgerRef),
      txn.get(holdRef),
    ])
    if (!topupSnap.exists) throw new TopupCreditError('TOPUP_NOT_FOUND')
    const topup = topupSnap.data() as { uid?: unknown; amountPaise?: unknown; status?: unknown; paymentId?: unknown }
    if (topup.uid !== uid)                 throw new TopupCreditError('TOPUP_OWNER_MISMATCH')
    if (topup.amountPaise !== amountPaise) throw new TopupCreditError('TOPUP_AMOUNT_MISMATCH')

    const current = walletSnap.exists
      ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0)
      : 0

    if (topup.status === 'credited') {
      // idempotent — no writes; report which payment it was credited with
      return {
        newBalance: current, credited: false,
        creditedPaymentId: typeof topup.paymentId === 'string' ? topup.paymentId : null,
      }
    }
    if (topup.status !== 'pending') throw new TopupCreditError('TOPUP_NOT_CREDITABLE')
    // RD-WALLET-W2.c — an order-level review hold on walletTopupReconciliation/{orderId} stops
    // EVERY automated credit — webhook, verify, retry and sweep all come through here — until
    // review clears it. Two statuses are holds, both UNRESOLVED by definition (nothing but a future
    // Super Admin resolution moves a record out of them):
    //   • 'needs_review' — a refusal / withheld credit awaiting review;
    //   • 'exhausted'    — W2.a: the retry limit was reached; approved as "blocks until Super
    //                      Admin review".
    // The refusal reaches each caller's existing refusal path, which keeps the payment id on that
    // record (never downgrading it). A replay of an order that is already credited still returns
    // idempotently above; 'pending' (the retry's own schedule), 'resolved' and 'skipped' are not
    // holds.
    const holdStatus = holdSnap.exists ? (holdSnap.data() as { status?: unknown }).status : undefined
    if (holdStatus === 'needs_review' || holdStatus === 'exhausted') {
      throw new TopupCreditError('TOPUP_REVIEW_HOLD')
    }
    // The ledger row and the 'credited' status are written together, so a row without the
    // status is an inconsistency to investigate — never a reason to credit again.
    if (ledgerSnap.exists) throw new TopupCreditError('TOPUP_LEDGER_CONFLICT')

    const updated = current + amountPaise
    txn.set(wRef, {
      balancePaise: updated,
      currency:     'INR',
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true })
    txn.update(topupRef, {
      status:    'credited',
      paymentId,
      updatedAt: FieldValue.serverTimestamp(),
    })
    // Immutable ledger entry — atomic with the credit (deterministic id, create-only).
    txn.create(ledgerRef, {
      organizerUid:  uid,
      type:          'fund_added',
      amountPaise,
      balancePaise:  updated,
      status:        'completed',
      referenceType: 'razorpay',
      referenceId:   orderId,
      orderId,
      paymentId,
      description:   `Razorpay topup — order ${orderId}`,
      metadata:      {},
      createdAt:     FieldValue.serverTimestamp(),
    })
    return { newBalance: updated, credited: true }
  })
}

// ─── RD-WALLET-W2.f — a Super Admin's reviewed credit of a HELD top-up ──────
//
// The one other writer of a top-up credit, kept beside atomicTopupCredit so the ledger row
// `topup_<orderId>` is still written only in this file. It differs in exactly one rule: an order
// held for review ('needs_review', or 'abandoned' with a late payment) may be credited — that is
// what the review decides. Everything else is the same exactly-once transaction: the order's owner
// and stored amount must match, an order already 'credited' is refused (never credited twice), and
// an existing ledger row is a conflict, never a second credit. No new balance or ledger: the same
// wallet document and the same create-only `topup_<orderId>` row.
//
// The caller must have verified the exact CAPTURED payment at the gateway first. `hooks.read` runs
// the caller's reads and checks (the review record) INSIDE the transaction before any write — a
// throw aborts with nothing written — and `hooks.stage` adds the review record and its audit row
// to the SAME commit.
export const REVIEW_CREDITABLE_TOPUP_STATUSES: ReadonlySet<string> = new Set(['pending', 'needs_review', 'abandoned'])

export interface ReviewedCreditHooks<T> {
  read:  (txn: FirebaseFirestore.Transaction, topup: Record<string, unknown>) => Promise<T>
  stage: (txn: FirebaseFirestore.Transaction, read: T, newBalance: number) => void
}

export async function creditTopupUnderReview<T>(
  uid:         string,
  amountPaise: number,
  topupRef:    FirebaseFirestore.DocumentReference,
  paymentId:   string,
  review:      { adminUid: string; recordId: string },
  hooks:       ReviewedCreditHooks<T>,
): Promise<{ newBalance: number }> {
  const wRef      = walletRef(uid)
  const orderId   = topupRef.id
  const ledgerRef = adminDb.collection('walletTransactions').doc(`topup_${orderId}`)

  return adminDb.runTransaction(async txn => {
    const [topupSnap, walletSnap, ledgerSnap] = await Promise.all([
      txn.get(topupRef),
      txn.get(wRef),
      txn.get(ledgerRef),
    ])
    if (!topupSnap.exists) throw new TopupCreditError('TOPUP_NOT_FOUND')
    const topup = topupSnap.data() as Record<string, unknown>
    const read = await hooks.read(txn, topup)
    if (topup.uid !== uid)                 throw new TopupCreditError('TOPUP_OWNER_MISMATCH')
    if (topup.amountPaise !== amountPaise) throw new TopupCreditError('TOPUP_AMOUNT_MISMATCH')
    // 'credited' is not in the set: an order is credited at most once, whoever asks.
    if (typeof topup.status !== 'string' || !REVIEW_CREDITABLE_TOPUP_STATUSES.has(topup.status)) {
      throw new TopupCreditError('TOPUP_NOT_CREDITABLE')
    }
    if (ledgerSnap.exists) throw new TopupCreditError('TOPUP_LEDGER_CONFLICT')

    const current = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    const updated = current + amountPaise
    txn.set(wRef, {
      balancePaise: updated,
      currency:     'INR',
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true })
    txn.update(topupRef, {
      status:       'credited',
      paymentId,
      reviewCredit: { by: review.adminUid, recordId: review.recordId, at: FieldValue.serverTimestamp() },
      updatedAt:    FieldValue.serverTimestamp(),
    })
    txn.create(ledgerRef, {
      organizerUid:  uid,
      type:          'fund_added',
      amountPaise,
      balancePaise:  updated,
      status:        'completed',
      referenceType: 'razorpay',
      referenceId:   orderId,
      orderId,
      paymentId,
      description:   `Razorpay topup — order ${orderId} (credited after Super Admin review)`,
      metadata:      { reviewedBy: review.adminUid, reviewRecordId: review.recordId },
      createdAt:     FieldValue.serverTimestamp(),
    })
    hooks.stage(txn, read, updated)
    return { newBalance: updated }
  })
}
