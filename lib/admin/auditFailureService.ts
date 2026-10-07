// lib/admin/auditFailureService.ts
// RD-PHASE4-S4 closeout — Super Admin review + reconciliation of `adminAuditFailures`.
//
// A failure record is written by logAdminActionOrRecord (lib/admin/audit.ts) when the audit row for
// an action whose money ALREADY moved at a gateway could not be written. The record holds the full
// (already sanitized) audit document, the error and `status: 'open'`.
//
// Reconciliation is audit bookkeeping only — it never touches money, wallets or gateway state:
//   replay       → re-create the missing adminAuditLogs row from the stored copy, at its ORIGINAL
//                  time, under the deterministic id `recovered_{failureId}` (`create` — a second
//                  replay can never add a second row), stamped with who recovered it and why.
//   mark_present → close the record WITHOUT writing, allowed only when the server itself finds a
//                  matching row (same entity + action, near the failure time) — the original write
//                  had landed after all. Never on the caller's word.
// Both run in ONE transaction that re-reads the record (only an `open` record moves), and stage an
// audit row for the reconciliation itself. Records are never deleted.
//
// Listing avoids a new composite index: it orders by createdAt only and applies the status /
// action / entity filters in memory over a bounded scan (reported as `scanned`).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ADMIN_AUDIT_FAILURES, sanitizeAuditValue, stageAdminAudit } from '@/lib/admin/audit'
import type {
  AuditFailureItem, AuditFailureListResponse, AuditFailureDetailResponse, AuditFailureActionResponse,
  AuditFailureStatusFilter, AuditFailureAction, AuditFailureResolution,
} from '@/lib/admin/auditFailureTypes'

export class AuditFailureError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) { super(message) }
}

/** How far from the failure time a row counts as "the same write that landed". */
export const MATCH_WINDOW_MS = 10 * 60 * 1000
const MAX_SCAN = 500

const col = () => adminDb.collection(ADMIN_AUDIT_FAILURES)
const recoveredId = (failureId: string) => `recovered_${failureId}`

function toMillis(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  return null
}
const iso = (v: unknown): string | null => { const m = toMillis(v); return m === null ? null : new Date(m).toISOString() }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? sanitizeAuditValue(v) as Record<string, unknown> : null

/**
 * Error text as shown to a Super Admin: bearer tokens, key=value secrets, e-mail addresses and long
 * opaque strings (keys, signatures, tokens) are redacted; length is capped. Pure.
 */
export function redactFailureError(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : 'unknown'
  return s
    .replace(/bearer\s+[\w\-.~+/]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(key|token|secret|password|signature|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[redacted]')
    .slice(0, 500)
}

export function toAuditFailureItem(id: string, d: Record<string, unknown>): AuditFailureItem {
  const a = (d.audit && typeof d.audit === 'object' ? d.audit : {}) as Record<string, unknown>
  const r = (d.resolution && typeof d.resolution === 'object' ? d.resolution : null) as Record<string, unknown> | null
  return {
    id,
    status:    d.status === 'resolved' ? 'resolved' : 'open',
    createdAt: iso(d.createdAt),
    error:     redactFailureError(d.error),
    audit: {
      action:      str(a.action),
      entityType:  str(a.entityType),
      entityId:    str(a.entityId),
      adminUid:    str(a.adminUid),
      actorRole:   typeof a.actorRole === 'string' ? a.actorRole : null,
      reason:      typeof a.reason === 'string' ? a.reason : null,
      at:          iso(a.createdAt),
      correlation: rec(a.correlation),
      metadata:    rec(a.metadata),
    },
    resolution: r ? {
      kind:             r.kind === 'already_present' ? 'already_present' : 'replayed',
      by:               str(r.by),
      at:               iso(r.at),
      reason:           str(r.reason),
      recoveredAuditId: typeof r.recoveredAuditId === 'string' ? r.recoveredAuditId : null,
    } : null,
  }
}

export interface AuditFailureFilters {
  status?:     AuditFailureStatusFilter
  action?:     string
  entityType?: string
  entityId?:   string
  /** ISO time of the last item of the previous page. */
  cursor?:     string
  pageSize?:   number
}

export async function listAuditFailures(f: AuditFailureFilters): Promise<AuditFailureListResponse> {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 100)
  const status = f.status ?? 'open'
  let q = col().orderBy('createdAt', 'desc') as FirebaseFirestore.Query
  const cursorMs = f.cursor ? Date.parse(f.cursor) : NaN
  if (Number.isFinite(cursorMs)) q = q.where('createdAt', '<', Timestamp.fromMillis(cursorMs))
  const snap = await q.limit(MAX_SCAN).get()

  const items: AuditFailureItem[] = []
  let lastSeen: string | null = null
  for (const d of snap.docs) {
    const item = toAuditFailureItem(d.id, d.data())
    lastSeen = item.createdAt
    if (status !== 'all' && item.status !== status) continue
    if (f.action && item.audit.action !== f.action) continue
    if (f.entityType && item.audit.entityType !== f.entityType) continue
    if (f.entityId && item.audit.entityId !== f.entityId) continue
    items.push(item)
    if (items.length >= pageSize) break
  }
  const exhausted = snap.size < MAX_SCAN && items.length < pageSize
  const last = items.length >= pageSize ? items[items.length - 1].createdAt : lastSeen
  return { items, nextCursor: exhausted ? null : last, scanned: snap.size }
}

/** Rows already in adminAuditLogs for the same entity + action within the match window. */
async function findExistingMatches(
  audit: Record<string, unknown>, failureAtMs: number | null,
  reader: { get: (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot> },
): Promise<Array<{ id: string; at: string | null; adminUid: string }>> {
  const entityId = str(audit.entityId), action = str(audit.action)
  if (!entityId || !action) return []
  const snap = await reader.get(adminDb.collection('adminAuditLogs')
    .where('entityId', '==', entityId).where('action', '==', action).limit(50))
  const around = failureAtMs ?? toMillis(audit.createdAt)
  return snap.docs
    .filter(d => !d.id.startsWith('recovered_'))
    .filter(d => {
      const at = toMillis(d.data().createdAt)
      return around === null || at === null ? false : Math.abs(at - around) <= MATCH_WINDOW_MS
    })
    .map(d => ({ id: d.id, at: iso(d.data().createdAt), adminUid: str(d.data().adminUid) }))
}

export async function getAuditFailureDetail(id: string): Promise<AuditFailureDetailResponse | null> {
  const snap = await col().doc(id).get()
  if (!snap.exists) return null
  const d = snap.data() as Record<string, unknown>
  const audit = (d.audit && typeof d.audit === 'object' ? d.audit : {}) as Record<string, unknown>
  const existingMatches = await findExistingMatches(audit, toMillis(d.createdAt), { get: q => q.get() })
  return { item: toAuditFailureItem(snap.id, d), existingMatches }
}

export async function reconcileAuditFailure(
  id: string, action: AuditFailureAction, adminUid: string, reason: string,
): Promise<AuditFailureActionResponse> {
  const ref = col().doc(id)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new AuditFailureError('Audit failure record not found.', 404, 'NOT_FOUND')
    const d = snap.data() as Record<string, unknown>
    if (d.status !== 'open') throw new AuditFailureError('This record is already reconciled.', 409, 'NOT_OPEN')
    const audit = (d.audit && typeof d.audit === 'object' ? d.audit : null) as Record<string, unknown> | null
    if (!audit || !str(audit.adminUid) || !str(audit.action) || !str(audit.entityType) || !str(audit.entityId)) {
      throw new AuditFailureError('The stored audit copy is incomplete and cannot be reconciled automatically.', 422, 'FAILURE_RECORD_INCOMPLETE')
    }

    let resolution: AuditFailureResolution
    let recoveredAuditId: string | null = null
    let matches: Array<{ id: string }> = []
    if (action === 'mark_present') {
      matches = await findExistingMatches(audit, toMillis(d.createdAt), { get: q => tx.get(q) })
      if (matches.length === 0) {
        throw new AuditFailureError('No matching audit row was found near the failure time. Replay it instead.', 409, 'NO_MATCHING_AUDIT_ROW')
      }
      resolution = 'already_present'
    } else {
      const outRef = adminDb.collection('adminAuditLogs').doc(recoveredId(id))
      if ((await tx.get(outRef)).exists) throw new AuditFailureError('This record was already replayed.', 409, 'ALREADY_REPLAYED')
      // The stored copy, at its ORIGINAL time, plus who recovered it and why. `create` — never an overwrite.
      tx.create(outRef, {
        ...audit,
        createdAt:              audit.createdAt ?? d.createdAt ?? FieldValue.serverTimestamp(),
        recoveredFromFailureId: id,
        recoveredBy:            adminUid,
        recoveredAt:            FieldValue.serverTimestamp(),
        recoveryReason:         reason,
      })
      resolution = 'replayed'
      recoveredAuditId = outRef.id
    }

    tx.update(ref, {
      status:     'resolved',
      resolution: { kind: resolution, by: adminUid, at: FieldValue.serverTimestamp(), reason, recoveredAuditId },
      updatedAt:  FieldValue.serverTimestamp(),
    })
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin',
      action:     resolution === 'replayed' ? 'audit_failure.replayed' : 'audit_failure.resolved_present',
      entityType: 'audit_failure', entityId: id, reason,
      changedFields: ['status', 'resolution'],
      before: { status: 'open' }, after: { status: 'resolved', resolution },
      metadata: {
        originalAction: str(audit.action), originalEntityType: str(audit.entityType), originalEntityId: str(audit.entityId),
        recoveredAuditId, matchedAuditIds: matches.map(m => m.id),
      },
      correlation: { failureId: id, entityId: str(audit.entityId) },
    })
    return { id, status: 'resolved', resolution, recoveredAuditId }
  })
}
