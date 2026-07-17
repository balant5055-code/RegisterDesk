// Integration audit log — organizer-scoped (mirrors team/broadcast audit).
// Written to `integrationAuditLogs`. entityType: 'integration'.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'

export const INTEGRATION_AUDIT_ACTIONS = [
  'apikey.created',
  'apikey.revoked',
  'webhook.created',
  'webhook.updated',
  'webhook.tested',
] as const

export type IntegrationAuditAction = typeof INTEGRATION_AUDIT_ACTIONS[number]

export interface IntegrationAuditParams {
  organizerUid: string
  actorUid:     string
  action:       IntegrationAuditAction
  entityId:     string                       // keyId or 'webhook'
  metadata?:    Record<string, unknown>
}

/** Fire-and-forget audit write — never blocks the calling action. */
export async function logIntegrationAction(params: IntegrationAuditParams): Promise<void> {
  await adminDb.collection('integrationAuditLogs').add({
    organizerUid: params.organizerUid,
    actorUid:     params.actorUid,
    action:       params.action,
    entityType:   'integration',
    entityId:     params.entityId,
    metadata:     params.metadata ?? {},
    createdAt:    FieldValue.serverTimestamp(),
  })
}
