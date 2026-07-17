// Wallet clawback service — durable tracking + recovery of insolvent reversals.
// Server-only (Admin SDK). Self-contained (inline debit math) so it can be
// imported by revenueWallets / platformTransactions without an import cycle.
//
// A clawback is created when a reversal (refund/dispute/chargeback/settlement
// reversal) needs to debit N paise from an organizer's revenue wallet but only M
// < N is available. The shortfall (N − M) is persisted as a debt that is paid
// down automatically whenever new revenue credits the wallet, oldest debt first.

import { FieldValue }   from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { logAdminAction } from '@/lib/admin/audit'
import type {
  ClawbackDocument, ClawbackStatus, ClawbackReason, ClawbackSourceType, ClawbackView,
} from '@/lib/clawbacks/types'

const COLLECTION = 'walletClawbacks'
const clawbackRef = (id: string) => adminDb.collection(COLLECTION).doc(id)
export const clawbackId = (transactionId: string) => `clawback_${transactionId}`

type ClawbackAuditAction =
  | 'clawback.created' | 'clawback.recovered' | 'clawback.partially_recovered' | 'clawback.waived'

/** Audit a clawback event. actorUid is 'system' for automated events. Best-effort. */
export async function logClawbackEvent(
  actorUid: string, action: ClawbackAuditAction, id: string, metadata?: Record<string, unknown>,
): Promise<void> {
  await logAdminAction({ adminUid: actorUid, action, entityType: 'clawback', entityId: id, metadata })
}

// ─── Detection (called INSIDE a reversal transaction) ─────────────────────────

export interface ClawbackShortfallInput {
  transactionId:       string
  organizerUid:        string
  sourceType:          ClawbackSourceType
  sourceId:            string
  reversalAmountPaise: number   // N — what needed reversing
  debitedPaise:        number   // M — what the wallet could actually cover now
  reason:              ClawbackReason
}

/**
 * Records a clawback for a reversal shortfall, ATOMICALLY inside the caller's
 * reversal transaction. Deterministic id (`clawback_${transactionId}`) +
 * create-once semantics make it idempotent: the caller's reversal is itself
 * idempotent (status guard / deterministic reversal-ledger id), so this write
 * happens exactly once per reversal. Returns the clawback summary when a shortfall
 * exists (so the caller can fire the audit after commit), else null.
 */
export function writeClawbackOnShortfall(
  tx: FirebaseFirestore.Transaction, input: ClawbackShortfallInput,
): { clawbackId: string; outstandingPaise: number } | null {
  const outstanding = input.reversalAmountPaise - input.debitedPaise
  if (outstanding <= 0) return null

  const id   = clawbackId(input.transactionId)
  const recovered = Math.max(0, input.debitedPaise)
  const status: ClawbackStatus = recovered > 0 ? 'partially_recovered' : 'open'

  tx.set(clawbackRef(id), {
    clawbackId:             id,
    organizerUid:           input.organizerUid,
    sourceType:             input.sourceType,
    sourceId:               input.sourceId,
    transactionId:          input.transactionId,
    reversalAmountPaise:    input.reversalAmountPaise,
    recoveredAmountPaise:   recovered,
    outstandingAmountPaise: outstanding,
    status,
    reason:                 input.reason,
    createdAt:              FieldValue.serverTimestamp(),
    updatedAt:              FieldValue.serverTimestamp(),
    resolvedAt:             null,
    resolvedBy:             null,
  } satisfies Record<keyof ClawbackDocument, unknown>)

  return { clawbackId: id, outstandingPaise: outstanding }
}

// ─── Recovery (called AFTER revenue credits the wallet) ───────────────────────

interface RecoveryEvent { clawbackId: string; recoveredPaise: number; fullyRecovered: boolean }

/**
 * Pays down open clawbacks from freshly-credited revenue, oldest first, bounded
 * by `budgetPaise` (the net amount that just credited). Each clawback is settled
 * in its own transaction that re-reads the wallet + clawback, so it is safe under
 * concurrency with refunds/disputes/other credits. Recovery never causes a new
 * shortfall: it debits at most the wallet's current (pending+available) balance,
 * which already includes the just-credited budget. Best-effort: never throws into
 * the credit path.
 */
export async function recoverClawbacks(organizerUid: string, budgetPaise: number): Promise<void> {
  if (!Number.isFinite(budgetPaise) || budgetPaise <= 0) return

  const walletRef = adminDb.collection('organizerRevenueWallets').doc(organizerUid)
  const events: RecoveryEvent[] = []
  let remaining = Math.floor(budgetPaise)

  try {
    // Bounded loop — each iteration settles the single oldest open clawback.
    for (let i = 0; i < 50 && remaining > 0; i++) {
      const snap = await adminDb.collection(COLLECTION)
        .where('organizerUid', '==', organizerUid)
        .where('status', 'in', ['open', 'partially_recovered'])
        .orderBy('createdAt', 'asc')
        .limit(1)
        .get()
      if (snap.empty) break

      const ref = snap.docs[0].ref
      const budgetForTxn = remaining

      const ev = await adminDb.runTransaction<RecoveryEvent | { stop: true } | null>(async tx => {
        const [cwSnap, wSnap] = await Promise.all([tx.get(ref), tx.get(walletRef)])
        if (!cwSnap.exists || !wSnap.exists) return null
        const c = cwSnap.data() as ClawbackDocument
        if (c.status === 'recovered' || c.status === 'waived') return null

        const pending   = (wSnap.data() as { pendingPaise?: number }).pendingPaise   ?? 0
        const available = (wSnap.data() as { availablePaise?: number }).availablePaise ?? 0
        const inTransit = (wSnap.data() as { inTransitPaise?: number }).inTransitPaise ?? 0

        const recoverable = Math.min(c.outstandingAmountPaise, budgetForTxn, pending + available)
        if (recoverable <= 0) return { stop: true }   // wallet drained — try later

        // Debit pending first, then available (mirrors computeWalletDebit).
        const fromPending   = Math.min(pending, recoverable)
        const fromAvailable = Math.min(available, recoverable - fromPending)
        const newAvailable  = available - fromAvailable
        const newInTransit  = Math.min(inTransit, newAvailable)   // preserve invariant

        tx.update(walletRef, {
          pendingPaise:   pending - fromPending,
          availablePaise: newAvailable,
          inTransitPaise: newInTransit,
          updatedAt:      FieldValue.serverTimestamp(),
        })

        const newRecovered   = c.recoveredAmountPaise + recoverable
        const newOutstanding = c.outstandingAmountPaise - recoverable
        const fully          = newOutstanding <= 0
        tx.update(ref, {
          recoveredAmountPaise:   newRecovered,
          outstandingAmountPaise: Math.max(0, newOutstanding),
          status:                 (fully ? 'recovered' : 'partially_recovered') satisfies ClawbackStatus,
          updatedAt:              FieldValue.serverTimestamp(),
          ...(fully ? { resolvedAt: FieldValue.serverTimestamp(), resolvedBy: 'system' } : {}),
        })

        return { clawbackId: c.clawbackId, recoveredPaise: recoverable, fullyRecovered: fully }
      })

      if (!ev || 'stop' in ev) break
      remaining -= ev.recoveredPaise
      events.push(ev)
    }
  } catch (err) {
    captureFinancialError(err, { scope: 'recoverClawbacks.recovery_failed', detail: 'recovery pass failed (non-fatal)', organizerUid })
  }

  for (const e of events) {
    void logClawbackEvent(
      'system',
      e.fullyRecovered ? 'clawback.recovered' : 'clawback.partially_recovered',
      e.clawbackId,
      { recoveredPaise: e.recoveredPaise, auto: true },
    ).catch(() => {})
  }
}

// ─── Queries + serialization (admin APIs) ─────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export function toClawbackView(d: ClawbackDocument): ClawbackView {
  return {
    clawbackId:             d.clawbackId,
    organizerUid:           d.organizerUid,
    sourceType:             d.sourceType,
    sourceId:               d.sourceId,
    transactionId:          d.transactionId,
    reversalAmountPaise:    d.reversalAmountPaise,
    recoveredAmountPaise:   d.recoveredAmountPaise,
    outstandingAmountPaise: d.outstandingAmountPaise,
    status:                 d.status,
    reason:                 d.reason,
    createdAt:              tsToISO(d.createdAt),
    updatedAt:              tsToISO(d.updatedAt),
    resolvedAt:             tsToISO(d.resolvedAt),
    resolvedBy:             d.resolvedBy,
  }
}

export interface ListClawbacksFilters {
  status?:       ClawbackStatus
  organizerUid?: string
  startDate?:    string   // ISO
  endDate?:      string   // ISO
  limit?:        number
}

export async function listClawbacks(f: ListClawbacksFilters): Promise<ClawbackView[]> {
  let q = adminDb.collection(COLLECTION) as FirebaseFirestore.Query
  if (f.organizerUid) q = q.where('organizerUid', '==', f.organizerUid)
  if (f.status)       q = q.where('status', '==', f.status)
  q = q.orderBy('createdAt', 'desc').limit(Math.min(f.limit ?? 100, 200))

  const snap = await q.get()
  let rows = snap.docs.map(doc => toClawbackView(doc.data() as ClawbackDocument))
  // Date filtering in memory (avoids extra composite indexes for an admin tool).
  if (f.startDate) rows = rows.filter(r => r.createdAt && r.createdAt >= f.startDate!)
  if (f.endDate)   rows = rows.filter(r => r.createdAt && r.createdAt <= f.endDate!)
  return rows
}

export async function getClawback(id: string): Promise<ClawbackView | null> {
  const snap = await clawbackRef(id).get()
  if (!snap.exists) return null
  return toClawbackView(snap.data() as ClawbackDocument)
}

// ─── Admin actions (waive / mark recovered) ───────────────────────────────────

export type AdminClawbackResult =
  | { ok: true; view: ClawbackView }
  | { ok: false; status: number; error: string }

/**
 * Admin write-off. Transactionally guards against acting on an already-resolved
 * clawback. Does NOT touch the wallet (a waiver forgives the debt; no debit).
 */
export async function waiveClawback(id: string, adminUid: string, note?: string): Promise<AdminClawbackResult> {
  const ref = clawbackRef(id)
  const result = await adminDb.runTransaction<AdminClawbackResult>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, status: 404, error: 'Clawback not found' }
    const c = snap.data() as ClawbackDocument
    if (c.status === 'recovered' || c.status === 'waived') {
      return { ok: false, status: 409, error: `Clawback is already ${c.status}.` }
    }
    tx.update(ref, {
      status:     'waived' satisfies ClawbackStatus,
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: adminUid,
      updatedAt:  FieldValue.serverTimestamp(),
      ...(note ? { resolutionNote: note.slice(0, 500) } : {}),
    })
    return { ok: true, view: { ...toClawbackView(c), status: 'waived', resolvedBy: adminUid } }
  })
  if (result.ok) void logClawbackEvent(adminUid, 'clawback.waived', id, { note: note ?? null }).catch(() => {})
  return result
}

/**
 * Admin manual resolution — marks the outstanding amount recovered out-of-band
 * (e.g. funds collected via a separate channel). Zeroes the outstanding without
 * debiting the wallet (the money came from elsewhere).
 */
export async function markClawbackRecovered(id: string, adminUid: string, note?: string): Promise<AdminClawbackResult> {
  const ref = clawbackRef(id)
  const result = await adminDb.runTransaction<AdminClawbackResult>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, status: 404, error: 'Clawback not found' }
    const c = snap.data() as ClawbackDocument
    if (c.status === 'recovered' || c.status === 'waived') {
      return { ok: false, status: 409, error: `Clawback is already ${c.status}.` }
    }
    tx.update(ref, {
      recoveredAmountPaise:   c.reversalAmountPaise,
      outstandingAmountPaise: 0,
      status:     'recovered' satisfies ClawbackStatus,
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: adminUid,
      updatedAt:  FieldValue.serverTimestamp(),
      ...(note ? { resolutionNote: note.slice(0, 500) } : {}),
    })
    return { ok: true, view: { ...toClawbackView(c), recoveredAmountPaise: c.reversalAmountPaise, outstandingAmountPaise: 0, status: 'recovered', resolvedBy: adminUid } }
  })
  if (result.ok) void logClawbackEvent(adminUid, 'clawback.recovered', id, { manual: true, note: note ?? null }).catch(() => {})
  return result
}
