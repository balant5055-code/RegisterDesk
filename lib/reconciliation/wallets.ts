// Wallet reconciliation (Phase G.5). REPORT ONLY — financial balances are NEVER
// auto-repaired. Verifies organizerRevenueWallets against platformTransactions +
// settlement records using cheap aggregation queries (no document reads).
//
// Invariants verified:
//   1. pending + available + inTransit + settled
//        == Σ platformTransactions.netSettlementPaise
//           − Σ net of rows reversed IN PLACE (registration refunds / disputes)
//           + outstanding clawbacks (open, partially recovered or waived)
//      RD-FIN-02 · two reversal shapes exist (lib/finance/ledgerReversal.ts): a DONATION refund writes
//      a negative row (already in Σ net); a REGISTRATION refund flips the original row to 'refunded'
//      and debits its net from the wallet with NO negative row — the old invariant flagged every one
//      of those as a mismatch. An insolvent reversal leaves the un-debited remainder as a clawback, so
//      the wallet sits higher by exactly its outstanding amount (a waive forgives it without touching
//      the wallet, so waived clawbacks still count). Genuine faults still surface: a row flipped to
//      'refunded' without a wallet debit, or a double debit, breaks the equation.
//   2. settledPaise == Σ settlementRequests(status='paid').amountPaise

import { AggregateField, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { getInPlaceReversedNet } from '@/lib/finance/financeAnalytics'
import { mismatch, RECON_PAGE_DEFAULT, type CounterMismatch, type ReconcileOptions, type ReconcileResult } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'

interface WalletData { pendingPaise?: number; availablePaise?: number; inTransitPaise?: number; settledPaise?: number }

async function sumField(q: FirebaseFirestore.Query, field: string): Promise<number> {
  const snap = await q.aggregate({ s: AggregateField.sum(field) }).get()
  return Number(snap.data().s ?? 0)
}

// Clawback states in which the un-debited remainder is still sitting in the wallet.
const WALLET_HELD_CLAWBACK = new Set(['open', 'partially_recovered', 'waived'])

export async function reconcileOneWallet(uid: string, w: WalletData): Promise<CounterMismatch[]> {
  const [netSum, reversed, clawSnap, settledExpected] = await Promise.all([
    sumField(adminDb.collection('platformTransactions').where('organizerUid', '==', uid), 'netSettlementPaise'),
    getInPlaceReversedNet({ organizerUid: uid, eventSlug: null }, 50_000),
    // Documents, equality only (no aggregate index). RD-FIN-02: the stored field is
    // `outstandingAmountPaise` — the old sum read `outstandingPaise`, which does not exist, so the
    // clawback term was always 0 and every insolvent reversal read as a mismatch.
    adminDb.collection('walletClawbacks').where('organizerUid', '==', uid).get(),
    sumField(adminDb.collection('settlementRequests').where('organizerUid', '==', uid).where('status', '==', 'paid'), 'amountPaise'),
  ])
  const clawbackHeld = clawSnap.docs.reduce((sum, d) => {
    const c = d.data() as { status?: string; outstandingAmountPaise?: unknown }
    return WALLET_HELD_CLAWBACK.has(c.status ?? '') ? sum + Number(c.outstandingAmountPaise ?? 0) : sum
  }, 0)

  const bucketSum = (w.pendingPaise ?? 0) + (w.availablePaise ?? 0) + (w.inTransitPaise ?? 0) + (w.settledPaise ?? 0)

  const out: CounterMismatch[] = []
  // repaired is ALWAYS false for wallets — report only.
  if (!reversed.ok) {
    // The reversal read failed: no balance verdict at all (never a guessed mismatch).
    captureError(new Error(`in-place reversal read ${reversed.reason}`), { scope: 'global_reconciliation', entityType: 'wallet', organizerUid: uid })
  } else {
    const expectedSum = netSum - reversed.paise + clawbackHeld
    if (bucketSum !== expectedSum) out.push(mismatch('wallet', uid, 'balanceSum', expectedSum, bucketSum, false))
  }
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
