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
