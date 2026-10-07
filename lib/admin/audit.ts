// lib/admin/audit.ts
// Immutable audit trail for all financial and administrative actions.
// Every record is written to adminAuditLogs/{auto-id} with a server timestamp.
//
// Usage:
//   await logAdminAction({ adminUid, action, entityType, entityId, reason, before, after, … })
//   stageAdminAudit(txnOrBatch, { … })          — in the SAME transaction / batch as the change
//   await logAdminActionOrRecord({ … })         — after an EXTERNAL (gateway) action already happened
//
// RD-PHASE4-S4 — the old guidance here was "always fire-and-forget". That is no longer the rule:
//   • a DATABASE-ONLY financial change stages its audit row in its own transaction/batch
//     (stageAdminAudit) — no change without its audit, and a failed audit write commits nothing;
//   • after an EXTERNAL action (a gateway refund/payout) the audit cannot be atomic with the money,
//     so logAdminActionOrRecord never throws and, if the audit write fails, durably records the
//     failure in `adminAuditFailures` (correlated) for reconciliation — the caller still reports the
//     TRUE money outcome.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { AdminAuditParams, AdminAuditLog } from './auditConstants'

// ─── Types & constants ──────────────────────────────────────────────────────
// The client-safe constants and types live in ./auditConstants (no firebase-admin
// import) so Client Components — e.g. the audit viewer filter dropdowns — can use
// them without dragging firebase-admin into the browser bundle. Re-exported here
// so existing server-side importers of '@/lib/admin/audit' keep working.
export {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AdminAuditAction,
  type AdminAuditEntityType,
  type AdminAuditParams,
  type AdminAuditLog,
  type AuditActorRole,
} from './auditConstants'

// ─── Writer ───────────────────────────────────────────────────────────────────

/** RD-PHASE4-S4 — where an audit write that FAILED after an external action is recorded. */
export const ADMIN_AUDIT_FAILURES = 'adminAuditFailures'

const MAX_REASON = 500
const MAX_STRING = 2_000
const MAX_DEPTH  = 6
// Never persisted in an audit row, whatever a caller passes (defence in depth — callers mask first).
const SECRET_KEY = /^(accountNumber|ifscCode|panNumber|upiId|cardNumber|cvv|password|secret|token|apiKey|privateKey|authorization)$/i

/**
 * Firestore-safe, bounded copy: drops `undefined` (the Admin SDK rejects it — RD-PHASE4-S4 F1), keeps
 * null, caps strings and depth, redacts secret-looking keys. Only plain objects/arrays are descended
 * into; sentinels (serverTimestamp), Timestamps and Dates pass through untouched.
 */
export function sanitizeAuditValue(v: unknown, depth = 0): unknown {
  if (v === undefined) return undefined
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return '[truncated]'
    return v.slice(0, 200).map(x => sanitizeAuditValue(x, depth + 1)).filter(x => x !== undefined)
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return v    // Timestamp, FieldValue, Date…
    if (depth >= MAX_DEPTH) return '[truncated]'
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue }
      const c = sanitizeAuditValue(x, depth + 1)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return String(v)
}

/** The stored document for an audit row (pure apart from the server-timestamp sentinel). */
export function buildAdminAuditDoc(params: AdminAuditParams): AdminAuditLog {
  const doc: Record<string, unknown> = {
    adminUid:   params.adminUid,
    action:     params.action,
    entityType: params.entityType,
    entityId:   params.entityId,
    createdAt:  FieldValue.serverTimestamp(),
  }
  const opt = {
    metadata:      params.metadata,
    actorRole:     params.actorRole,
    reason:        typeof params.reason === 'string' ? params.reason.trim().slice(0, MAX_REASON) : undefined,
    changedFields: params.changedFields,
    before:        params.before,
    after:         params.after,
    correlation:   params.correlation,
  }
  for (const [k, v] of Object.entries(opt)) {
    const c = sanitizeAuditValue(v)
    if (c !== undefined) doc[k] = c
  }
  return doc as unknown as AdminAuditLog
}

export async function logAdminAction(params: AdminAuditParams): Promise<void> {
  await adminDb.collection('adminAuditLogs').add(buildAdminAuditDoc(params))
}

/**
 * RD-PHASE4-S4 — stage the audit row on the CALLER's transaction or batch, so the financial change
 * and its audit commit together (a failed audit write commits neither). `create` — append-only: a
 * deterministic `docId` can never overwrite an existing row.
 */
export function stageAdminAudit(
  writer: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch,
  params: AdminAuditParams,
  docId?: string,
): FirebaseFirestore.DocumentReference {
  const col = adminDb.collection('adminAuditLogs')
  const ref = docId ? col.doc(docId) : col.doc()
  ;(writer as FirebaseFirestore.WriteBatch).create(ref, buildAdminAuditDoc(params) as unknown as FirebaseFirestore.DocumentData)
  return ref
}

/**
 * RD-PHASE4-S4 — after an EXTERNAL action (money already moved at a gateway): write the audit row,
 * and if THAT fails, durably record the failure (correlated) for reconciliation. Never throws — the
 * caller reports the true money outcome regardless. Returns whether the audit row was written.
 */
export async function logAdminActionOrRecord(params: AdminAuditParams): Promise<boolean> {
  try {
    await logAdminAction(params)
    return true
  } catch (err) {
    try {
      await adminDb.collection(ADMIN_AUDIT_FAILURES).add({
        audit:     buildAdminAuditDoc(params),
        error:     err instanceof Error ? err.message.slice(0, 500) : 'unknown',
        status:    'open',
        createdAt: FieldValue.serverTimestamp(),
      })
    } catch (err2) {
      captureFinancialError(err2, { scope: 'audit.failure_record_failed', action: params.action, entityId: params.entityId })
    }
    captureFinancialError(err, { scope: 'audit.write_failed_after_external_action', action: params.action, entityId: params.entityId })
    return false
  }
}
