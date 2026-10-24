// Phase 3.1 · PER-BUCKET revenue-wallet reconciliation — READ-ONLY, report-only (never writes a wallet,
// a payout request or history). The existing sum check (lib/reconciliation/wallets.ts) cannot see money
// sitting in the WRONG bucket; this derives each bucket from the authoritative records:
//
//   pendingPaise   = Σ net of the organizer's COMPLETED ledger rows not yet released (releaseStatus
//                    'pending' / 'held') − Σ partial donation reversals of those still-unreleased parents
//                    (a reversal row carries parentTransactionId; it was debited from pending)
//   settledPaise   = Σ settlementRequests 'paid'
//   availablePaise = (total the ledger says the wallet holds) − pending − settled
//                    where total = Σ net − in-place reversals + clawback debt still held (the existing,
//                    tested identity). In-transit is NOT a separate bucket: a payout request reserves
//                    inTransitPaise INSIDE availablePaise (organizer request: inTransit += amount,
//                    available unchanged; mark-paid: available −= amount, inTransit −= amount)
//   inTransitPaise = Σ open payout requests holding a reservation (reserved === true, status pending /
//                    approved) — the rule lib/settlements/reconcile.ts rebuilds it by; and never above
//                    availablePaise
//
// A bucket whose inputs cannot be established (a read failed or was capped; a COMPLETED row with no
// recognisable releaseStatus — legacy) gets NO verdict ('unverifiable'), never a guessed mismatch.

export type WalletBucket = 'pendingPaise' | 'availablePaise' | 'inTransitPaise' | 'settledPaise'

export interface BucketVerdict {
  bucket:   WalletBucket
  expected: number | null
  stored:   number
  variance: number | null          // stored − expected
  verdict:  'ok' | 'mismatch' | 'unverifiable'
}

export interface WalletBucketInputs {
  stored: { pendingPaise?: number; availablePaise?: number; inTransitPaise?: number; settledPaise?: number }
  /** The existing identity's total (Σ net − in-place reversed + held clawbacks); null = unverifiable. */
  expectedTotal:     number | null
  /** Σ unreleased nets (see above); null = unverifiable. */
  expectedPending:   number | null
  expectedSettled:   number | null
  expectedInTransit: number | null
}

export interface WalletBucketReport {
  buckets: BucketVerdict[]
  /** In-transit above available (a payout reservation no longer backed); 0 when consistent. */
  inTransitExcessPaise: number
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** PURE — compare stored buckets with their ledger-derived expectations. */
export function evaluateWalletBuckets(i: WalletBucketInputs): WalletBucketReport {
  const stored = { pendingPaise: n(i.stored.pendingPaise), availablePaise: n(i.stored.availablePaise), inTransitPaise: n(i.stored.inTransitPaise), settledPaise: n(i.stored.settledPaise) }
  const expectedAvailable = i.expectedTotal !== null && i.expectedPending !== null && i.expectedSettled !== null
    ? i.expectedTotal - i.expectedPending - i.expectedSettled : null
  const verdict = (bucket: WalletBucket, expected: number | null): BucketVerdict => ({
    bucket, expected, stored: stored[bucket],
    variance: expected === null ? null : stored[bucket] - expected,
    verdict: expected === null ? 'unverifiable' : stored[bucket] === expected ? 'ok' : 'mismatch',
  })
  return {
    buckets: [
      verdict('pendingPaise', i.expectedPending),
      verdict('availablePaise', expectedAvailable),
      verdict('inTransitPaise', i.expectedInTransit),
      verdict('settledPaise', i.expectedSettled),
    ],
    inTransitExcessPaise: Math.max(0, stored.inTransitPaise - stored.availablePaise),
  }
}

/** Reads beyond this are not trusted to be complete: the bucket gets no verdict. */
export const BUCKET_LEDGER_READ_CAP = 50_000

export interface BucketLedger {
  expectedPending:   number | null
  expectedInTransit: number | null
  /** COMPLETED rows with no recognisable releaseStatus (legacy): their bucket is unknown. */
  unknownReleaseStatus: { count: number; sampleIds: string[] }
  why?: string
}

/** READ-ONLY — the ledger inputs for one organizer (equality-filtered reads; no new index). */
export async function readBucketLedger(db: FirebaseFirestore.Firestore, organizerUid: string): Promise<BucketLedger> {
  const out: BucketLedger = { expectedPending: null, expectedInTransit: null, unknownReleaseStatus: { count: 0, sampleIds: [] } }
  // pending: completed rows by release state. Equality filters only (no orderBy, so a legacy row without
  // paidAt is never silently left out); served by single-field index merging — no composite index needed.
  try {
    const completed = await db.collection('platformTransactions')
      .where('organizerUid', '==', organizerUid).where('status', '==', 'completed')
      .select('netSettlementPaise', 'releaseStatus').limit(BUCKET_LEDGER_READ_CAP + 1).get()
    const reversals = await db.collection('platformTransactions')
      .where('organizerUid', '==', organizerUid).where('status', '==', 'refunded')
      .select('netSettlementPaise', 'parentTransactionId').limit(BUCKET_LEDGER_READ_CAP + 1).get()
    if (completed.size > BUCKET_LEDGER_READ_CAP || reversals.size > BUCKET_LEDGER_READ_CAP) {
      out.why = 'ledger_read_capped'
    } else {
      let pending = 0
      const unreleased = new Set<string>()
      for (const d of completed.docs) {
        const rs = d.get('releaseStatus')
        if (rs === 'pending' || rs === 'held') { pending += n(d.get('netSettlementPaise')); unreleased.add(d.id) }
        else if (rs !== 'released') {
          out.unknownReleaseStatus.count++
          if (out.unknownReleaseStatus.sampleIds.length < 20) out.unknownReleaseStatus.sampleIds.push(d.id)
        }
      }
      for (const d of reversals.docs) {
        const parent = d.get('parentTransactionId')
        if (typeof parent === 'string' && unreleased.has(parent)) pending += n(d.get('netSettlementPaise'))   // negative row
      }
      if (out.unknownReleaseStatus.count === 0) out.expectedPending = pending
      else out.why = 'unknown_release_status'
    }
  } catch (err) {
    out.why = `ledger_read_failed:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`
  }
  // in transit: open payout requests holding a reservation (declared index organizerUid, status)
  try {
    const reqs = await db.collection('settlementRequests')
      .where('organizerUid', '==', organizerUid).where('status', 'in', ['pending', 'approved']).limit(BUCKET_LEDGER_READ_CAP + 1).get()
    if (reqs.size <= BUCKET_LEDGER_READ_CAP) {
      out.expectedInTransit = reqs.docs.reduce((s, d) => s + (d.get('reserved') === true ? n(d.get('amountPaise')) : 0), 0)
    }
  } catch { /* stays null → unverifiable */ }
  return out
}
