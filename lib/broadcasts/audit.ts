// Broadcast audit log — organizer-scoped, written to `broadcastAuditLogs`.
// Mirrors the team audit pattern (separate from admin audit).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'

export const BROADCAST_AUDIT_ACTIONS = [
  'broadcast.scheduled',
  'broadcast.sent',
  'broadcast.failed',
  'broadcast.cancelled',
] as const

export type BroadcastAuditAction = typeof BROADCAST_AUDIT_ACTIONS[number]

export interface BroadcastAuditParams {
  organizerUid: string
  actorUid:     string                       // the operator (callerUid), not the workspace
  action:       BroadcastAuditAction
  campaignId:   string
  metadata?:    Record<string, unknown>
}

/** Fire-and-forget audit write — never blocks the broadcast flow. */
export async function logBroadcastAction(params: BroadcastAuditParams): Promise<void> {
  await adminDb.collection('broadcastAuditLogs').add({
    organizerUid: params.organizerUid,
    actorUid:     params.actorUid,
    action:       params.action,
    entityType:   'broadcast',
    entityId:     params.campaignId,
    metadata:     params.metadata ?? {},
    createdAt:    FieldValue.serverTimestamp(),
  })
}
