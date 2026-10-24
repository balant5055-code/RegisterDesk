// Phase 3.10A — durable EVIDENCE of settlement-release attempts that did not release (server-only, Admin SDK).
//
// settlementReleaseAttempts/{ptxId} — one document per ledger row the release job tried and could not release:
//   transactionId, organizerUid, status 'open' | 'resolved', attempts, firstAttemptAt, lastAttemptAt,
//   lastCode (stable), codeCounts.{code}, lastRunId, lastOutcome 'refused' | 'error' | 'released',
//   lastDetail (INSUFFICIENT: the pending and the amount it was refused against), resolvedAt,
//   resolvedByReleaseId
// It never touches the ledger row, a wallet or a release record, and it is written OUTSIDE the release
// transaction, after its outcome is final: a failure to write evidence is logged and can never block, retry,
// change or corrupt a release. Idempotent per release run (lastRunId): recording the same run twice counts once;
// two concurrent runs are two genuine attempts and serialise on the document. A row already released is never
// recorded as failing. A successful release marks an open record resolved (kept, not deleted, as evidence).
// No backfill: rows refused before this existed have no record.
// Phase 3.10B — cost: a successful release checks for an open record with ONE plain read taken AFTER its release
// committed (a transaction only when a record is open); a refusal reads its record and the ledger row in ONE
// getAll inside its transaction. Every Firestore call, including building document references, sits inside the
// error boundary: these functions never throw into the release job.
// Access: Admin SDK only. No rule matches this collection, so Firestore's default denies every client.

import { FieldValue, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import { releasableNetAfterManualRefunds } from '@/lib/refunds/manualRefundRules'

export const RELEASE_ATTEMPTS_COLLECTION = 'settlementReleaseAttempts'

/** The release job's own refusal codes (lib/settlements/releaseFunds.ts); anything else is not a stable refusal. */
export const RELEASE_FAILURE_CODES = ['INSUFFICIENT', 'NO_WALLET', 'INVALID_AMOUNT', 'CLAWBACK_SET_TOO_LARGE', 'CLAWBACK_INVALID'] as const
export type ReleaseFailureCode = typeof RELEASE_FAILURE_CODES[number] | 'TRANSIENT_OR_UNKNOWN'
/** Not failures: an idempotency race (already released / gone) or a refund hold (the row is held, not refused). */
const NOT_RECORDED = new Set(['ALREADY_RELEASED', 'TX_GONE', 'REFUND_HOLD'])

export interface ReleaseAttemptDoc {
  transactionId: string
  organizerUid: string | null
  status: 'open' | 'resolved'
  attempts: number
  firstAttemptAt: unknown
  lastAttemptAt: unknown
  lastCode: ReleaseFailureCode
  codeCounts: Partial<Record<ReleaseFailureCode, number>>
  lastRunId: string
  lastOutcome: 'refused' | 'error' | 'released'
  lastDetail?: { pendingPaise: number; amountPaise: number } | null
  resolvedAt?: unknown
  resolvedByReleaseId?: string
}

/** PURE — the stable code of a release failure, and whether it is evidence worth recording. */
export function classifyReleaseFailure(message: string): { record: false } | { record: true; code: ReleaseFailureCode; outcome: 'refused' | 'error'; detail: { pendingPaise: number; amountPaise: number } | null } {
  const head = message.split(':')[0]
  if (NOT_RECORDED.has(head)) return { record: false }
  if ((RELEASE_FAILURE_CODES as readonly string[]).includes(head)) {
    const parts = message.split(':')
    const detail = head === 'INSUFFICIENT' && parts.length >= 3 && /^-?\d+$/.test(parts[1]) && /^-?\d+$/.test(parts[2])
      ? { pendingPaise: Number(parts[1]), amountPaise: Number(parts[2]) } : null
    // INSUFFICIENT is the job's deterministic refusal; the others are data problems the job refuses on
    return { record: true, code: head as ReleaseFailureCode, outcome: head === 'INSUFFICIENT' ? 'refused' : 'error', detail }
  }
  // a Firestore / runtime error: real, but transient or unknown — evidence, never a confirmed refusal
  return { record: true, code: 'TRANSIENT_OR_UNKNOWN', outcome: 'error', detail: null }
}

export type RecordAttemptResult = 'recorded' | 'duplicate' | 'not_recorded' | 'already_released' | 'unrecorded'

/** Records ONE failed attempt (idempotent per run). Never throws: a failure to record is logged and returned. */
export async function recordReleaseFailure(input: { ptxId: string; organizerUid: string | null; runId: string; message: string }): Promise<RecordAttemptResult> {
  const c = classifyReleaseFailure(input.message)
  if (!c.record) return 'not_recorded'
  try {
    const ref = adminDb.collection(RELEASE_ATTEMPTS_COLLECTION).doc(input.ptxId)
    const ptxRef = adminDb.collection('platformTransactions').doc(input.ptxId)
    return await adminDb.runTransaction<RecordAttemptResult>(async tx => {
      // Phase 3.10B — both documents in ONE read (the ledger row is the race guard: a row released by a
      // concurrent run is never recorded as failing)
      const [snap, ptx] = await tx.getAll(ref, ptxRef)
      if (ptx.exists && ptx.get('releaseStatus') === 'released') return 'already_released'   // a concurrent run released it
      const prev = snap.exists ? snap.data() as ReleaseAttemptDoc : null
      if (prev?.lastRunId === input.runId) return 'duplicate'
      const now = FieldValue.serverTimestamp()
      tx.set(ref, {
        transactionId: input.ptxId,
        organizerUid: input.organizerUid,
        status: 'open',
        attempts: (typeof prev?.attempts === 'number' ? prev.attempts : 0) + 1,
        ...(prev ? {} : { firstAttemptAt: now }),
        lastAttemptAt: now,
        lastCode: c.code,
        codeCounts: { ...(prev?.codeCounts ?? {}), [c.code]: ((prev?.codeCounts ?? {})[c.code] ?? 0) + 1 },
        lastRunId: input.runId,
        lastOutcome: c.outcome,
        lastDetail: c.detail,
      }, { merge: true })
      return 'recorded'
    })
  } catch (err) {
    captureError(err, { scope: 'settlement_release_attempts', detail: 'release attempt evidence not recorded', transactionId: input.ptxId })
    return 'unrecorded'
  }
}

/**
 * Marks an OPEN record resolved once its row released. Never throws.
 * Phase 3.10B — called AFTER the release committed, it first takes ONE plain read: no record, or one not open,
 * ends here with no transaction (the common case). This is race-free: a concurrent run's refusal record reads the
 * ledger row in its own transaction, so it can only commit BEFORE this release committed (and is then visible to
 * this read) — after the commit it sees the row released and records nothing. Only an open record pays for the
 * resolving transaction, which re-checks it.
 */
export async function resolveReleaseAttempt(input: { ptxId: string; releaseId: string }): Promise<'resolved' | 'none' | 'unrecorded'> {
  try {
    const ref = adminDb.collection(RELEASE_ATTEMPTS_COLLECTION).doc(input.ptxId)
    const first = await ref.get()
    if (!first.exists || first.get('status') !== 'open') return 'none'
    return await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists || snap.get('status') !== 'open') return 'none' as const
      tx.update(ref, { status: 'resolved', lastOutcome: 'released', resolvedAt: FieldValue.serverTimestamp(), resolvedByReleaseId: input.releaseId })
      return 'resolved' as const
    })
  } catch (err) {
    captureError(err, { scope: 'settlement_release_attempts', detail: 'release attempt not marked resolved', transactionId: input.ptxId })
    return 'unrecorded'
  }
}

// ─── Phase 3.10C · resolving OPEN evidence whose row's release is DEFINITIVELY confirmed ─────────────────────
//
// An open record can outlive its row's release when a run ended between the release commit and its evidence
// check (`released_unresolved`). It is resolved here ONLY when, read in ONE transaction:
//   • the ledger row exists, is 'completed' and 'released', and carries no refund hold (a refund opened AFTER a
//     release puts a hold on the released row — it stays open, reported held, until that review lifts the hold);
//   • EXACTLY ONE settlementReleases record names it, for exactly the row's net.
// Then the record becomes 'resolved' (kept, history intact) with resolution 'confirmed_release' and the release id.
// Never resolved: a missing, reversed, held, unreadable or still-pending row (its state is reported); a release
// state that disagrees with the release records (reported as an inconsistency, nothing written). Idempotent: a
// record no longer open is left alone, so concurrent sweeps resolve it once. It writes ONLY evidence documents.
// Bounded: one page of open records per call, in id order, resumed from a durable cursor, and a deadline checked
// only BEFORE a record starts (a record's transaction always finishes; the cursor stops at the last one done).

export const EVIDENCE_SWEEP_PAGE = 100

export type EvidenceSweepOutcome =
  | 'resolved' | 'not_open' | 'missing_record'
  | 'row_deleted' | 'row_reversed' | 'row_held' | 'still_eligible' | 'row_unreadable'
  | 'inconsistent_no_release_record' | 'inconsistent_multiple_release_records' | 'inconsistent_release_amount'
  | 'inconsistent_release_record_but_not_released' | 'unrecorded'

/** One record (transactional, idempotent). Never throws. */
export async function resolveConfirmedReleaseEvidence(ptxId: string): Promise<EvidenceSweepOutcome> {
  try {
    const ref = adminDb.collection(RELEASE_ATTEMPTS_COLLECTION).doc(ptxId)
    const ptxRef = adminDb.collection('platformTransactions').doc(ptxId)
    return await adminDb.runTransaction<EvidenceSweepOutcome>(async tx => {
      const [att, row] = await tx.getAll(ref, ptxRef)
      const releases = await tx.get(adminDb.collection('settlementReleases').where('transactionId', '==', ptxId).limit(2))
      if (!att.exists) return 'missing_record'
      if (att.get('status') !== 'open') return 'not_open'
      if (!row.exists) return 'row_deleted'
      const status = row.get('status'), releaseStatus = row.get('releaseStatus')
      // reported, never resolved (a reversed row may have been released before its refund: a release record is normal)
      if (status === 'refunded' || status === 'disputed') return 'row_reversed'
      if (status !== 'completed') return 'row_unreadable'
      if (releaseStatus === 'held' || row.get('releaseHold')) return 'row_held'
      if (releaseStatus === 'pending') return releases.size > 0 ? 'inconsistent_release_record_but_not_released' : 'still_eligible'
      if (releaseStatus !== 'released') return 'row_unreadable'
      // completed + released + no hold: confirmed ONLY by exactly one release record for exactly the row's net
      if (releases.size === 0) return 'inconsistent_no_release_record'
      if (releases.size > 1) return 'inconsistent_multiple_release_records'
      const rel = releases.docs[0]
      // RD-REFUND-MANUAL-01 — the release moves the net LESS any manual refund reversed before it (releaseFunds).
      if (rel.get('amountPaise') !== releasableNetAfterManualRefunds(row.get('netSettlementPaise'), row.get('manualRefund')?.reversedNetPaise)) return 'inconsistent_release_amount'
      tx.update(ref, {
        status: 'resolved', lastOutcome: 'released', resolvedAt: FieldValue.serverTimestamp(), resolvedByReleaseId: rel.id,
        resolution: 'confirmed_release',
      })
      return 'resolved'
    })
  } catch (err) {
    captureError(err, { scope: 'settlement_release_attempts', detail: 'confirmed-release evidence sweep failed', transactionId: ptxId })
    return 'unrecorded'
  }
}

/** One bounded page of OPEN records (id order, durable cursor). Never throws; writes only evidence documents. */
export async function sweepConfirmedReleaseEvidence(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ scanned: number; stoppedByBudget: boolean; outcomes: Partial<Record<EvidenceSweepOutcome, number>>; inconsistencies: Array<{ ptxId: string; outcome: EvidenceSweepOutcome }> }> {
  const out = { scanned: 0, stoppedByBudget: false, outcomes: {} as Partial<Record<EvidenceSweepOutcome, number>>, inconsistencies: [] as Array<{ ptxId: string; outcome: EvidenceSweepOutcome }> }
  const deadline = opts.budgetMs === undefined ? Infinity : Date.now() + opts.budgetMs
  try {
    const pageSize = opts.limit ?? EVIDENCE_SWEEP_PAGE
    const cursorKey = 'recon:release-evidence-sweep'
    const after = await readCursor(cursorKey)
    let q = adminDb.collection(RELEASE_ATTEMPTS_COLLECTION).where('status', '==', 'open').orderBy(FieldPath.documentId())
    if (after) q = q.startAfter(after)
    const page = await q.limit(pageSize).get()
    for (const d of page.docs) {
      if (Date.now() >= deadline) { out.stoppedByBudget = true; break }
      out.scanned++
      const o = await resolveConfirmedReleaseEvidence(d.id)
      out.outcomes[o] = (out.outcomes[o] ?? 0) + 1
      if (o.startsWith('inconsistent_')) out.inconsistencies.push({ ptxId: d.id, outcome: o })
    }
    // budget stop: resume after the last record done; full page: after its last; short page: wrap to the start
    if (out.stoppedByBudget) { if (out.scanned > 0) await writeCursor(cursorKey, page.docs[out.scanned - 1].id) }
    else await writeCursor(cursorKey, page.size === pageSize ? page.docs[page.docs.length - 1].id : null)
  } catch (err) {
    captureError(err, { scope: 'settlement_release_attempts', detail: 'confirmed-release evidence sweep page failed' })
  }
  return out
}
