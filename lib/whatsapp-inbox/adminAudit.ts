// WhatsApp Inbox — audit of Super Admin access to attendee conversations. Server-only.
//
// The Super Admin inbox shows attendee phone numbers and message text across every organizer,
// so each view of a conversation, each unmatched-message evidence view and each mark-read is
// recorded in adminAuditLogs (lib/admin/audit).
//
// ═══ ONE ROW PER ADMIN, ITEM, ACTION AND HOUR ════════════════════════════════
// The page polls an open thread every 30 s. An append-per-request log would bury every other
// audit row, so the row id is deterministic over (admin, action, item, hour) and written with
// `create()`: the first access in an hour is recorded, repeats are ALREADY_EXISTS and skipped.
//
// ═══ NEVER BLOCKS THE READ ═══════════════════════════════════════════════════
// The data has already been authorized (authorizeSuperAdminInbox) and read; an audit-store
// outage must not lock the Super Admin out of supervision. A failed write is logged (ids only)
// for operations to reconcile.
//
// Metadata carries ids only — never a message body, a phone number or an attendee name.

import { createHash } from 'node:crypto'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import type { AdminAuditAction, AdminAuditEntityType } from '@/lib/admin/auditConstants'

const HOUR_MS        = 60 * 60 * 1_000
const ALREADY_EXISTS = 6   // gRPC status code

export type InboxAuditAction = Extract<AdminAuditAction,
  'whatsapp_inbox.conversation_viewed' | 'whatsapp_inbox.conversation_marked_read' | 'whatsapp_inbox.unmatched_viewed'>

/** Deterministic audit row id for (admin, action, item, hour). Exported for tests. */
export function inboxAuditDocId(adminUid: string, action: InboxAuditAction, entityId: string, nowMs = Date.now()): string {
  const bucket = Math.floor(nowMs / HOUR_MS)
  return `wainbox_${createHash('sha256').update(`${adminUid}|${action}|${entityId}|${bucket}`).digest('hex').slice(0, 40)}`
}

export async function auditInboxAccess(args: {
  adminUid:   string
  action:     InboxAuditAction
  entityType: Extract<AdminAuditEntityType, 'whatsapp_conversation' | 'whatsapp_inbound'>
  entityId:   string
  /** Ids only (organizerUid, eventId, routing reason). */
  metadata?:  Record<string, string | null>
  nowMs?:     number
}): Promise<'recorded' | 'already' | 'failed'> {
  try {
    const batch = adminDb.batch()
    stageAdminAudit(batch, {
      adminUid:   args.adminUid,
      actorRole:  'super_admin',
      action:     args.action,
      entityType: args.entityType,
      entityId:   args.entityId,
      metadata:   args.metadata,
    }, inboxAuditDocId(args.adminUid, args.action, args.entityId, args.nowMs))
    await batch.commit()
    return 'recorded'
  } catch (err) {
    if ((err as { code?: unknown })?.code === ALREADY_EXISTS) return 'already'
    console.error(`[admin/whatsapp-inbox] access audit write failed · action=${args.action} · entity=${args.entityId} · ${(err as Error)?.message?.slice(0, 200) ?? 'error'}`)
    return 'failed'
  }
}
