// lib/admin/audit.ts
// Immutable audit trail for all financial and administrative actions.
// Every record is written to adminAuditLogs/{auto-id} with a server timestamp.
//
// Usage:
//   void logAdminAction({ adminUid, action, entityType, entityId, metadata })
//
// Always fire-and-forget — audit failures must never block the primary flow.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
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
} from './auditConstants'

// ─── Writer ───────────────────────────────────────────────────────────────────

export async function logAdminAction(params: AdminAuditParams): Promise<void> {
  const doc: AdminAuditLog = {
    adminUid:   params.adminUid,
    action:     params.action,
    entityType: params.entityType,
    entityId:   params.entityId,
    createdAt:  FieldValue.serverTimestamp(),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
  }

  await adminDb.collection('adminAuditLogs').add(doc)
}
