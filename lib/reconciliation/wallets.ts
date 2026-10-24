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
//   3. Phase 3.1 — PER BUCKET (lib/reconciliation/walletBuckets.ts): pendingPaise, availablePaise and
//      inTransitPaise each against its ledger derivation, and inTransit ≤ available. Reported with the same
//      mismatch shape (field = the bucket); a bucket that cannot be derived gets no verdict.
//      In-transit is a reservation INSIDE availablePaise (a payout request raises inTransit without lowering
//      available; paying it lowers both), so invariant 1 sums pending + available + settled — counting
//      inTransit on top reported every organizer with an open payout request as a mismatch.

import { AggregateField, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { getInPlaceReversedNet } from '@/lib/finance/financeAnalytics'
import { mismatch, unverifiable, RECON_PAGE_DEFAULT, RECON_BUDGET_MS, type CounterMismatch, type ReconcileOptions, type ReconcileResult, type ReconcileUnverifiable } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import { evaluateWalletBuckets, readBucketLedger, type WalletBucketReport, type BucketLedger } from '@/lib/reconciliation/walletBuckets'

interface WalletData { pendingPaise?: number; availablePaise?: number; inTransitPaise?: number; settledPaise?: number }

async function sumField(q: FirebaseFirestore.Query, field: string): Promise<number> {
  const snap = await q.aggregate({ s: AggregateField.sum(field) }).get()
  return Number(snap.data().s ?? 0)
}

// Clawback states in which the un-debited remainder is still sitting in the wallet.
const WALLET_HELD_CLAWBACK = new Set(['open', 'partially_recovered', 'waived'])

/**
 * The part of one clawback that is still sitting in the wallet (never debited from it):
 *   • the outstanding debt, while open / partially recovered / waived, and
 *   • Phase 3.3 — whatever was collected OFF-PLATFORM (offPlatformRecoveredAmountPaise, any status): the
 *     organizer paid it outside the wallet, so the wallet balance still holds it. It is NOT money the
 *     wallet owes — counting it here stops a manual recovery reading as a wallet mismatch.
 * Wallet-funded recovery (recoveredAmountPaise) is NOT held: the release credited that much less.
 */
export function clawbackWalletHeldPaise(c: { status?: unknown; outstandingAmountPaise?: unknown; offPlatformRecoveredAmountPaise?: unknown }): number {
  const outstanding = WALLET_HELD_CLAWBACK.has(String(c.status ?? '')) ? Number(c.outstandingAmountPaise ?? 0) : 0
  const off = typeof c.offPlatformRecoveredAmountPaise === 'number' && Number.isFinite(c.offPlatformRecoveredAmountPaise) ? c.offPlatformRecoveredAmountPaise : 0
  return outstanding + off
}

/**
 * Phase 3.3 (verification) — every write path keeps one clawback's own arithmetic exact:
 *   reversalAmountPaise = recoveredAmountPaise (from the wallet) + outstandingAmountPaise + offPlatformRecoveredAmountPaise
 * (creation: recovered = immediate debit; release: outstanding → recovered; manual: outstanding → off-platform;
 * waive: status only). So clawbackWalletHeldPaise is exactly reversal − wallet-funded recovery: the part of the
 * reversal that never left the wallet. A record that breaks the identity (edited out of band, or not a number)
 * could raise or lower that term and mask an unrelated wallet discrepancy — it is reported, never trusted.
 * Returns the gap (expected = reversal, actual = the sum of the parts; -1 when a part is unreadable), or null.
 */
export function clawbackArithmeticGap(c: { reversalAmountPaise?: unknown; recoveredAmountPaise?: unknown; outstandingAmountPaise?: unknown; offPlatformRecoveredAmountPaise?: unknown }): { expected: number; actual: number } | null {
  const n = (v: unknown, absent: number | null) => (v === undefined ? absent : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
  const reversal = n(c.reversalAmountPaise, null), recovered = n(c.recoveredAmountPaise, 0), outstanding = n(c.outstandingAmountPaise, null), off = n(c.offPlatformRecoveredAmountPaise, 0)
  if (reversal === null || recovered === null || outstanding === null || off === null) {
    return { expected: typeof c.reversalAmountPaise === 'number' ? c.reversalAmountPaise : 0, actual: -1 }
  }
  const parts = recovered + outstanding + off
  return parts === reversal ? null : { expected: reversal, actual: parts }
}

/** Phase 3.1 — the detailed per-bucket report (expected, stored, variance) for one organizer. Read-only. */
export async function reconcileWalletBuckets(uid: string, w: WalletData): Promise<WalletBucketReport & { ledger: BucketLedger; expectedTotal: number | null }> {
  const { expectedTotal, settledExpected } = await walletIdentity(uid)
  const ledger = await readBucketLedger(adminDb, uid)
  const report = evaluateWalletBuckets({
    stored: w, expectedTotal, expectedPending: ledger.expectedPending, expectedSettled: settledExpected, expectedInTransit: ledger.expectedInTransit,
  })
  return { ...report, ledger, expectedTotal }
}

/** The existing identity's inputs: the total the ledger says the wallet holds, and the paid-out total. */
async function walletIdentity(uid: string): Promise<{ expectedTotal: number | null; settledExpected: number }> {
  const [netSum, reversed, clawSnap, settledExpected] = await Promise.all([
    sumField(adminDb.collection('platformTransactions').where('organizerUid', '==', uid), 'netSettlementPaise'),
    getInPlaceReversedNet({ organizerUid: uid, eventSlug: null }, 50_000),
    adminDb.collection('walletClawbacks').where('organizerUid', '==', uid).get(),
    sumField(adminDb.collection('settlementRequests').where('organizerUid', '==', uid).where('status', '==', 'paid'), 'amountPaise'),
  ])
  const clawbackHeld = clawSnap.docs.reduce((sum, d) => sum + clawbackWalletHeldPaise(d.data()), 0)
  return { expectedTotal: reversed.ok ? netSum - reversed.paise + clawbackHeld : null, settledExpected }
}

/**
 * Phase 3.6A — the wallet verdict. Report-only: nothing is ever written to a wallet or ledger.
 *   clean        — every check completed and agreed
 *   mismatch     — at least one completed check disagreed (each listed in `mismatches`)
 *   unverifiable — at least one required check could NOT complete (a read failed or hit its safety cap, a
 *                  legacy record lacks a field the calculation needs, a stored value is unreadable). Missing
 *                  evidence is never read as zero and never yields `clean`.
 * Mismatches found by the checks that did complete are always kept, even when others were unverifiable.
 */
export interface WalletVerdict {
  status:       'clean' | 'mismatch' | 'unverifiable'
  mismatches:   CounterMismatch[]
  unverifiable: ReconcileUnverifiable[]
}

/** Thrown by reconcileOneWallet for a wallet that could not be verified: an empty list must mean clean. */
export class WalletUnverifiableError extends Error {
  constructor(readonly uid: string, readonly reasons: ReconcileUnverifiable[]) {
    super(`wallet ${uid} unverifiable: ${reasons.map(r => `${r.check}:${r.reason}`).join('; ')}`)
    this.name = 'WalletUnverifiableError'
  }
}

const STORED_BUCKETS = ['pendingPaise', 'availablePaise', 'inTransitPaise', 'settledPaise'] as const

export async function verifyOneWallet(uid: string, w: WalletData): Promise<WalletVerdict> {
  const out: CounterMismatch[] = []
  const unv: ReconcileUnverifiable[] = []
  const note = (check: string, reason: string) => unv.push(unverifiable('wallet', uid, check, reason))
  const verdict = (): WalletVerdict => ({ status: out.length ? 'mismatch' : unv.length ? 'unverifiable' : 'clean', mismatches: out, unverifiable: unv })

  let netSum: number, reversed: Awaited<ReturnType<typeof getInPlaceReversedNet>>, clawSnap: FirebaseFirestore.QuerySnapshot, settledExpected: number
  try {
    ;[netSum, reversed, clawSnap, settledExpected] = await Promise.all([
      sumField(adminDb.collection('platformTransactions').where('organizerUid', '==', uid), 'netSettlementPaise'),
      getInPlaceReversedNet({ organizerUid: uid, eventSlug: null }, 50_000),
      // Documents, equality only (no aggregate index). RD-FIN-02: the stored field is
      // `outstandingAmountPaise` — the old sum read `outstandingPaise`, which does not exist, so the
      // clawback term was always 0 and every insolvent reversal read as a mismatch.
      adminDb.collection('walletClawbacks').where('organizerUid', '==', uid).get(),
      sumField(adminDb.collection('settlementRequests').where('organizerUid', '==', uid).where('status', '==', 'paid'), 'amountPaise'),
    ])
  } catch (err) {
    note('ledger_inputs', `read_failed:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`)
    return verdict()
  }
  const ledger = await readBucketLedger(adminDb, uid)

  // The stored buckets themselves. Every credit initialises all four (buildRevenueCreditUpdate), so an absent
  // or non-numeric bucket is a legacy / damaged record and is never simply read as 0 — with ONE corroborated
  // exception: a wallet from before payouts existed has no inTransitPaise / settledPaise. Those two are
  // independently derivable (open reserved requests; paid requests), so an ABSENT one is read as 0 only when
  // its own source also shows 0. pending / available have no independent source: absent ⇒ unverifiable.
  const stored: WalletData = { ...w }
  const badBuckets: Array<typeof STORED_BUCKETS[number]> = []
  for (const b of STORED_BUCKETS) {
    const v = w[b]
    if (typeof v === 'number' && Number.isFinite(v)) continue
    if (v === undefined && b === 'settledPaise' && settledExpected === 0) { stored.settledPaise = 0; continue }
    if (v === undefined && b === 'inTransitPaise' && ledger.expectedInTransit === 0) { stored.inTransitPaise = 0; continue }
    badBuckets.push(b)
    note(`stored:${b}`, v === undefined ? 'field_missing' : 'not_a_number')
  }

  // Phase 3.3 (verification) — a clawback whose own arithmetic does not hold cannot vouch for the balance
  // term: it is reported (report-only). One with an UNREADABLE part makes the balance unverifiable.
  let clawbackReadable = true
  for (const d of clawSnap.docs) {
    const gap = clawbackArithmeticGap(d.data())
    if (gap && gap.actual === -1) { clawbackReadable = false; note(`clawback:${d.id}`, 'unreadable_amount') }
    else if (gap) out.push(mismatch('wallet', uid, `clawbackArithmetic:${d.id}`, gap.expected, gap.actual, false))
  }
  const clawbackHeld = clawSnap.docs.reduce((sum, d) => sum + clawbackWalletHeldPaise(d.data()), 0)
  const totalKnown = reversed.ok && clawbackReadable && Number.isFinite(clawbackHeld)
  if (!reversed.ok) note('balanceSum', `in_place_reversals_${reversed.reason}`)
  const expectedTotal = totalKnown && reversed.ok ? netSum - reversed.paise + clawbackHeld : null

  // inTransit is held INSIDE availablePaise (see invariant 3) — never added on top.
  const sumBucketsKnown = !badBuckets.some(b => b !== 'inTransitPaise')
  if (expectedTotal !== null && sumBucketsKnown) {
    const bucketSum = (stored.pendingPaise as number) + (stored.availablePaise as number) + (stored.settledPaise as number)
    if (bucketSum !== expectedTotal) out.push(mismatch('wallet', uid, 'balanceSum', expectedTotal, bucketSum, false))
  }
  if (typeof stored.settledPaise === 'number' && stored.settledPaise !== settledExpected) out.push(mismatch('wallet', uid, 'settledPaise', settledExpected, stored.settledPaise, false))

  // Phase 3.1 — per bucket (settled is reported above, once). Same report-only mismatch shape.
  const buckets = evaluateWalletBuckets({
    stored, expectedTotal,
    expectedPending: ledger.expectedPending, expectedSettled: settledExpected, expectedInTransit: ledger.expectedInTransit,
  })
  for (const b of buckets.buckets) {
    if (b.bucket === 'settledPaise') continue
    if (badBuckets.includes(b.bucket)) continue                       // already unverifiable: its stored value is unknown
    if (b.verdict === 'mismatch') out.push(mismatch('wallet', uid, b.bucket, b.expected!, b.stored, false))
    else if (b.verdict === 'unverifiable') note(b.bucket, b.bucket === 'inTransitPaise' ? 'payout_requests_unreadable' : (ledger.why ?? (expectedTotal === null ? 'total_unverifiable' : 'derivation_unavailable')))
  }
  if (!badBuckets.length && buckets.inTransitExcessPaise > 0) out.push(mismatch('wallet', uid, 'inTransitWithinAvailable', 0, buckets.inTransitExcessPaise, false))
  if (ledger.why === 'unknown_release_status') note('legacy_rows', `release_status_missing:${ledger.unknownReleaseStatus.count}:${ledger.unknownReleaseStatus.sampleIds.slice(0, 5).join(',')}`)
  if (unv.length) captureError(new Error(`wallet unverifiable: ${unv.map(u => `${u.check}:${u.reason}`).join('; ')}`.slice(0, 500)), { scope: 'global_reconciliation', entityType: 'wallet', organizerUid: uid })
  return verdict()
}

/**
 * The mismatches of a VERIFIABLE wallet (an empty list means clean). A wallet that cannot be verified
 * throws WalletUnverifiableError — never a silent "clean". Prefer verifyOneWallet for the full verdict.
 */
export async function reconcileOneWallet(uid: string, w: WalletData): Promise<CounterMismatch[]> {
  const v = await verifyOneWallet(uid, w)
  if (v.status === 'unverifiable') throw new WalletUnverifiableError(uid, v.unverifiable)
  return v.mismatches
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
  const unv: ReconcileUnverifiable[] = []
  let scanned = 0
  // Phase 3.9 — a wall-clock budget (as the other reconcilers have): a run the cron's maxDuration kills writes
  // nothing and never advances, so the same page would be retried forever. A stop is reported, never clean.
  const deadline = Date.now() + (opts?.budgetMs ?? RECON_BUDGET_MS)
  let lastDone: string | null = null
  for (const doc of wallets.docs) {
    if (Date.now() > deadline) break
    scanned++
    try {
      const v = await verifyOneWallet(doc.id, doc.data() as WalletData)
      all.push(...v.mismatches)
      unv.push(...v.unverifiable)
    } catch (err) {
      // Phase 3.6A — a wallet whose check threw is UNVERIFIABLE (reported), never silently skipped as clean.
      unv.push(unverifiable('wallet', doc.id, 'check', `failed:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`))
      captureError(err, { scope: 'global_reconciliation', entityType: 'wallet', organizerUid: doc.id })
    }
    lastDone = doc.id
  }

  const finished = scanned === wallets.size
  if (!finished) unv.push(unverifiable('wallet', 'wallets', `scan:${cursorKey}`, `budget_exhausted_after:${lastDone ?? after ?? 'start'}`))
  await writeCursor(cursorKey, finished ? (wallets.size === pageSize ? lastDone : null) : (lastDone ?? after))

  // repaired is always 0 — financial balances are never written by reconciliation.
  return { entityType: 'wallet', scanned, mismatches: all, unverifiable: unv, repaired: 0 }
}
