// Wallet clawback service — durable tracking + recovery of insolvent reversals.
// Server-only (Admin SDK). Self-contained (inline debit math) so it can be
// imported by revenueWallets / platformTransactions without an import cycle.
//
// A clawback is created when a reversal (refund/dispute/chargeback/settlement
// reversal) needs to debit N paise from an organizer's revenue wallet but only M
// < N is available. The shortfall (N − M) is persisted as a debt that is paid
// down automatically, oldest debt first, when the organizer's later revenue is
// RELEASED — inside the release transaction (Phase 3 · Option C; see
// lib/settlements/releaseFunds.ts and lib/clawbacks/recoveryPlan.ts). It is never
// recovered from pendingPaise at credit time.

import { FieldValue }   from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import { logAdminActionOrRecord, stageAdminAudit } from '@/lib/admin/audit'
import type {
  ClawbackDocument, ClawbackStatus, ClawbackReason, ClawbackSourceType, ClawbackView,
} from '@/lib/clawbacks/types'

const COLLECTION = 'walletClawbacks'
const clawbackRef = (id: string) => adminDb.collection(COLLECTION).doc(id)
export const clawbackId = (transactionId: string) => `clawback_${transactionId}`

type ClawbackAuditAction =
  | 'clawback.created' | 'clawback.recovered' | 'clawback.partially_recovered' | 'clawback.waived'

/** Audit a clawback event. actorUid is 'system' for automated events. Best-effort. */
/**
 * RD-PHASE4-S4 — a SYSTEM clawback event (creation / automatic recovery), written after the
 * reversal or recovery transaction committed. Never throws; a failed write is durably recorded
 * (adminAuditFailures) for reconciliation. Callers AWAIT it — it is no longer detached.
 * Admin waive / mark-recovered do NOT use this: their audit is staged in their own transaction.
 */
export async function logClawbackEvent(
  actorUid: string, action: ClawbackAuditAction, id: string, metadata?: Record<string, unknown>,
): Promise<boolean> {
  return logAdminActionOrRecord({
    adminUid: actorUid, actorRole: actorUid === 'system' ? 'system' : 'super_admin',
    action, entityType: 'clawback', entityId: id, metadata,
    correlation: { clawbackId: id },
  })
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
  } satisfies Record<Exclude<keyof ClawbackDocument, 'offPlatformRecoveredAmountPaise' | 'offPlatformRecoveries'>, unknown>)   // off-platform fields are added only by a manual recovery

  return { clawbackId: id, outstandingPaise: outstanding }
}

// ─── Recovery ─────────────────────────────────────────────────────────────────
// Phase 3 (Option C): automatic recovery happens ONLY inside the settlement-release transaction
// (lib/settlements/releaseFunds.ts, planned by lib/clawbacks/recoveryPlan.ts). The former credit-time
// recoverClawbacks — which took the debt from pendingPaise and left the credited transaction fully
// releasable — was removed.

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
    offPlatformRecoveredAmountPaise: typeof d.offPlatformRecoveredAmountPaise === 'number' ? d.offPlatformRecoveredAmountPaise : 0,
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
export async function waiveClawback(id: string, adminUid: string, reason: string): Promise<AdminClawbackResult> {
  const note = reason
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
    // RD-PHASE4-S4 — the audit row commits WITH the waiver (or neither does).
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin', action: 'clawback.waived', entityType: 'clawback', entityId: id,
      reason,
      changedFields: ['status', 'resolvedAt', 'resolvedBy', 'resolutionNote'],
      before: { status: c.status, outstandingAmountPaise: c.outstandingAmountPaise },
      after:  { status: 'waived', outstandingAmountPaise: c.outstandingAmountPaise },
      metadata: { note, organizerUid: c.organizerUid, outstandingAmountPaise: c.outstandingAmountPaise },
      correlation: { clawbackId: id, organizerUid: c.organizerUid, transactionId: c.transactionId },
    })
    return { ok: true, view: { ...toClawbackView(c), status: 'waived', resolvedBy: adminUid } }
  })
  return result
}

/**
 * Admin manual resolution — marks the outstanding amount recovered out-of-band
 * (e.g. funds collected via a separate channel). Zeroes the outstanding without
 * debiting the wallet (the money came from elsewhere).
 */
const CLAWBACK_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Super Admin — the debt (or part of it) was collected OUTSIDE the wallet (e.g. a bank transfer).
 * Phase 3.3: the amount is recorded in `offPlatformRecoveredAmountPaise` (+ an `offPlatformRecoveries`
 * entry), SEPARATE from `recoveredAmountPaise` (wallet-funded recovery, which is kept as it was). No
 * wallet balance changes — the wallet was never debited for this part, and reconciliation counts it as
 * still held in the wallet (lib/reconciliation/wallets.ts clawbackWalletHeldPaise).
 *   • no amount ⇒ the whole outstanding debt (status 'recovered', resolved);
 *   • an amount ⇒ a PARTIAL recovery (1 … outstanding paise; requestId required). Equal to the
 *     outstanding ⇒ 'recovered'; less ⇒ 'partially_recovered' (the rest stays recoverable).
 * A requestId makes the call idempotent: the same requestId again returns the current state unchanged.
 */
export async function markClawbackRecovered(
  id: string, adminUid: string, reason: string, opts: { amountPaise?: number; requestId?: string } = {},
): Promise<AdminClawbackResult & { duplicate?: boolean }> {
  const note = reason
  const ref = clawbackRef(id)
  const partialRequested = opts.amountPaise !== undefined
  if (partialRequested && (!Number.isSafeInteger(opts.amountPaise) || (opts.amountPaise as number) <= 0)) {
    return { ok: false, status: 400, error: 'amountPaise must be a positive whole number of paise.' }
  }
  if (opts.requestId !== undefined && !CLAWBACK_REQUEST_ID_RE.test(opts.requestId)) {
    return { ok: false, status: 400, error: 'requestId must be 8–64 letters, digits, "-" or "_".' }
  }
  if (partialRequested && !opts.requestId) return { ok: false, status: 400, error: 'A requestId is required for a partial recovery.' }
  const auditId = opts.requestId ? `clawback_recovered_${id}_${opts.requestId}`.slice(0, 1400) : undefined
  const auditRef = auditId ? adminDb.collection('adminAuditLogs').doc(auditId) : null
  const result = await adminDb.runTransaction<AdminClawbackResult & { duplicate?: boolean }>(async tx => {
    const [snap, prior] = await Promise.all([tx.get(ref), auditRef ? tx.get(auditRef) : Promise.resolve(null)])
    if (!snap.exists) return { ok: false, status: 404, error: 'Clawback not found' }
    const c = snap.data() as ClawbackDocument
    // A repeated request (same requestId) is answered from the current state — nothing is recorded twice.
    if (prior?.exists) {
      const m = (prior.data() as { metadata?: { amountPaise?: unknown; partialRequested?: unknown } }).metadata
      if (partialRequested && m?.amountPaise !== opts.amountPaise) return { ok: false, status: 409, error: 'This requestId was already used for a different amount.' }
      return { ok: true, duplicate: true, view: toClawbackView(c) }
    }
    if (c.status === 'recovered' || c.status === 'waived') {
      return { ok: false, status: 409, error: `Clawback is already ${c.status}.` }
    }
    const outstanding = c.outstandingAmountPaise
    if (!Number.isSafeInteger(outstanding) || outstanding <= 0) return { ok: false, status: 409, error: 'This clawback has no recoverable outstanding amount.' }
    const amount = partialRequested ? opts.amountPaise as number : outstanding
    if (amount > outstanding) return { ok: false, status: 400, error: `amountPaise exceeds the outstanding ${outstanding} paise.` }
    const prevOff = typeof c.offPlatformRecoveredAmountPaise === 'number' ? c.offPlatformRecoveredAmountPaise : 0
    const nextOutstanding = outstanding - amount
    const full = nextOutstanding === 0
    const status: ClawbackStatus = full ? 'recovered' : 'partially_recovered'
    const key = opts.requestId ?? `full_${Date.now()}`
    tx.update(ref, {
      offPlatformRecoveredAmountPaise: prevOff + amount,
      [`offPlatformRecoveries.${key}`]: { amountPaise: amount, by: adminUid, at: FieldValue.serverTimestamp(), reason: note.slice(0, 500) },
      outstandingAmountPaise: nextOutstanding,
      status,
      ...(full ? { resolvedAt: FieldValue.serverTimestamp(), resolvedBy: adminUid } : {}),
      updatedAt:  FieldValue.serverTimestamp(),
      ...(note && full ? { resolutionNote: note.slice(0, 500) } : {}),
    })
    // RD-PHASE4-S4 — the audit row commits WITH the resolution (or neither does).
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin', action: 'clawback.recovered', entityType: 'clawback', entityId: id,
      reason,
      changedFields: ['status', 'offPlatformRecoveredAmountPaise', 'offPlatformRecoveries', 'outstandingAmountPaise', ...(full ? ['resolvedAt', 'resolvedBy', 'resolutionNote'] : [])],
      before: { status: c.status, recoveredAmountPaise: c.recoveredAmountPaise, offPlatformRecoveredAmountPaise: prevOff, outstandingAmountPaise: outstanding },
      after:  { status, recoveredAmountPaise: c.recoveredAmountPaise, offPlatformRecoveredAmountPaise: prevOff + amount, outstandingAmountPaise: nextOutstanding },
      metadata: { manual: true, offPlatform: true, amountPaise: amount, partial: !full, note, organizerUid: c.organizerUid, ...(opts.requestId ? { requestId: opts.requestId } : {}) },
      correlation: { clawbackId: id, organizerUid: c.organizerUid, transactionId: c.transactionId },
    }, auditId)
    return { ok: true, duplicate: false, view: { ...toClawbackView(c), offPlatformRecoveredAmountPaise: prevOff + amount, outstandingAmountPaise: nextOutstanding, status, ...(full ? { resolvedBy: adminUid } : {}) } }
  })
  return result
}
