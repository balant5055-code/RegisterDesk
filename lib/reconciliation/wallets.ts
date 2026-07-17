// Wallet reconciliation (Phase G.5). REPORT ONLY — financial balances are NEVER
// auto-repaired. Verifies organizerRevenueWallets against platformTransactions +
// settlement records using cheap aggregation queries (no document reads).
//
// Invariants verified:
//   1. pending + available + inTransit + settled
//        == Σ platformTransactions.netSettlementPaise  +  outstanding clawbacks
//      (reversals are negative net entries; an insolvent reversal leaves the
//       un-debited remainder as a clawback, so the wallet sits higher by exactly
//       the outstanding clawback total — the invariant accounts for that.)
//   2. settledPaise == Σ settlementRequests(status='paid').amountPaise

import { AggregateField, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { mismatch, RECON_PAGE_DEFAULT, type CounterMismatch, type ReconcileOptions, type ReconcileResult } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'

interface WalletData { pendingPaise?: number; availablePaise?: number; inTransitPaise?: number; settledPaise?: number }

async function sumField(q: FirebaseFirestore.Query, field: string): Promise<number> {
  const snap = await q.aggregate({ s: AggregateField.sum(field) }).get()
  return Number(snap.data().s ?? 0)
}

async function reconcileOneWallet(uid: string, w: WalletData): Promise<CounterMismatch[]> {
  const [netSum, clawbackOutstanding, settledExpected] = await Promise.all([
    sumField(adminDb.collection('platformTransactions').where('organizerUid', '==', uid), 'netSettlementPaise'),
    sumField(adminDb.collection('walletClawbacks').where('organizerUid', '==', uid).where('status', 'in', ['open', 'partially_recovered']), 'outstandingPaise'),
    sumField(adminDb.collection('settlementRequests').where('organizerUid', '==', uid).where('status', '==', 'paid'), 'amountPaise'),
  ])

  const bucketSum = (w.pendingPaise ?? 0) + (w.availablePaise ?? 0) + (w.inTransitPaise ?? 0) + (w.settledPaise ?? 0)
  const expectedSum = netSum + clawbackOutstanding

  const out: CounterMismatch[] = []
  // repaired is ALWAYS false for wallets — report only.
  if (bucketSum !== expectedSum) out.push(mismatch('wallet', uid, 'balanceSum', expectedSum, bucketSum, false))
  if ((w.settledPaise ?? 0) !== settledExpected) out.push(mismatch('wallet', uid, 'settledPaise', settledExpected, w.settledPaise ?? 0, false))
  return out
}

export async function reconcileWallets(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const pageSize = opts?.limit ?? RECON_PAGE_DEFAULT
  const cursorKey = 'recon:wallet'

  // Bounded, cursor-resumed page (full docs — the balance buckets are needed) so a
  // single run can't overrun the timeout; the full set is covered across ticks.
  const after = await readCursor(cursorKey)
  let q = adminDb.collection('organizerRevenueWallets').orderBy(FieldPath.documentId()).limit(pageSize)
  if (after) q = q.startAfter(after)
  const wallets = await q.get()

  const all: CounterMismatch[] = []
  let scanned = 0
  for (const doc of wallets.docs) {
    scanned++
    try { all.push(...await reconcileOneWallet(doc.id, doc.data() as WalletData)) }
    catch (err) { captureError(err, { scope: 'global_reconciliation', entityType: 'wallet', organizerUid: doc.id }) }
  }

  const lastId = wallets.docs.length ? wallets.docs[wallets.docs.length - 1].id : null
  await writeCursor(cursorKey, wallets.size === pageSize ? lastId : null)

  // repaired is always 0 — financial balances are never written by reconciliation.
  return { entityType: 'wallet', scanned, mismatches: all, repaired: 0 }
}
