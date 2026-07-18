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

// ─── Top-up (called after Razorpay payment verified) ─────────────────────────

export async function creditWallet(uid: string, amountPaise: number): Promise<number> {
  const ref = walletRef(uid)
  const result = await adminDb.runTransaction(async (txn) => {
    const snap    = await txn.get(ref)
    const current = snap.exists ? ((snap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    const updated = current + amountPaise
    txn.set(ref, {
      balancePaise: updated,
      currency:     'INR',
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true })
    return updated
  })
  return result
}

// Atomically credits the wallet, marks the topup 'credited', AND writes the
// immutable wallet-transaction ledger entry — all in ONE transaction. This
// eliminates the double-credit window (audit C-1) and the previous gap where the
// ledger was a separate fire-and-forget write that could be lost. Idempotent: if
// the topup is already 'credited', returns { credited: false } and writes nothing
// (the ledger doc id is deterministic, so even a forced re-run never duplicates).
//
// orderId is taken from topupRef.id (walletTopups is keyed by Razorpay order id).
export async function atomicTopupCredit(
  uid:         string,
  amountPaise: number,
  topupRef:    FirebaseFirestore.DocumentReference,
  paymentId:   string,
): Promise<{ newBalance: number; credited: boolean }> {
  const wRef     = walletRef(uid)
  const orderId  = topupRef.id
  const ledgerRef = adminDb.collection('walletTransactions').doc(`topup_${orderId}`)

  return adminDb.runTransaction(async txn => {
    const [topupSnap, walletSnap] = await Promise.all([
      txn.get(topupRef),
      txn.get(wRef),
    ])
    const topup   = topupSnap.data() as { status: string }
    const current = walletSnap.exists
      ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0)
      : 0

    if (topup.status === 'credited') {
      return { newBalance: current, credited: false }  // idempotent — no writes needed
    }

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
    // Immutable ledger entry — atomic with the credit (deterministic id).
    txn.set(ledgerRef, {
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
