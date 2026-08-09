// MC-02 · Wallet persistence — SERVER ONLY. NO BUSINESS LOGIC.
//
// Firestore access for `mediaCreditWallets/{organizerUid}`. This file reads and writes; it
// never decides whether a balance change is allowed. Every rule lives in
// `utils/ledgerMath.ts` (pure) and `services/` (orchestration).
//
// Wallet creation is LAZY: a workspace that has never held credits has no document, and
// `read()` returns null rather than fabricating a zero-balance record. The distinction
// matters — "never had a wallet" and "has a wallet holding nothing" are different facts,
// and only the ledger can tell them apart.

import type { Transaction } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_WALLETS, MEDIA_CREDIT_SCHEMA_VERSION, type CreditWalletDoc,
} from '@/features/media-credits/types'
import type { WalletBalances } from '@/features/media-credits/utils/ledgerMath'

const wallets = () => adminDb.collection(MEDIA_CREDIT_WALLETS)

export const walletRef = (organizerUid: string) => wallets().doc(organizerUid)

/** Non-transactional read. Null when the workspace has no wallet document. */
export async function read(organizerUid: string): Promise<CreditWalletDoc | null> {
  const snap = await walletRef(organizerUid).get()
  return snap.exists ? (snap.data() as CreditWalletDoc) : null
}

/** Transactional read. Must be called before any write in the same transaction. */
export async function readInTx(
  tx: Transaction, organizerUid: string,
): Promise<CreditWalletDoc | null> {
  const snap = await tx.get(walletRef(organizerUid))
  return snap.exists ? (snap.data() as CreditWalletDoc) : null
}

/**
 * Writes the balances, creating the document on first use.
 *
 * `set(..., { merge: true })` rather than `update()` so lazy creation and subsequent updates
 * are the same call — an `update()` on a missing document would throw, forcing every caller
 * to branch on existence.
 */
export function writeBalancesInTx(
  tx: Transaction, organizerUid: string, next: WalletBalances,
): void {
  tx.set(walletRef(organizerUid), {
    organizerUid,
    schemaVersion:    MEDIA_CREDIT_SCHEMA_VERSION,
    balance:          next.balance,
    heldCredits:      next.heldCredits,
    // RD-MC-REFUND-V2-P3 · written unconditionally, so a wallet that has ever had a refund
    // hold always carries the field and never falls back to the `?? 0` read path with a
    // stale value behind it.
    refundHeldCredits: next.refundHeldCredits,
    lifetimeGranted:  next.lifetimeGranted,
    lifetimeConsumed: next.lifetimeConsumed,
    updatedAt:        FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * MC-08 · A bounded page of wallets, for platform aggregation.
 *
 * ADMIN-ONLY BY CALLER. There is no tenant filter here because the whole point is to sum
 * across tenants; the authorization sits in the admin route, and no organizer path reaches
 * this function.
 *
 * Bounded deliberately. Firestore can count documents but cannot sum a field, so a platform
 * total has to read them — and an unbounded read of every wallet is exactly the kind of query
 * that is fine on day one and a timeout at scale. The caller reports `truncated` when the cap
 * is hit, so a partial figure is visibly partial rather than quietly wrong.
 */
export async function listAll(limit: number): Promise<{
  wallets: CreditWalletDoc[]
  truncated: boolean
}> {
  // One extra document than asked for: its presence is how we know more remain.
  const snap = await wallets().limit(limit + 1).get()
  return {
    wallets: snap.docs.slice(0, limit).map(d => d.data() as CreditWalletDoc),
    truncated: snap.size > limit,
  }
}
