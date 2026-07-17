// Custom-domain audit log — organizer-scoped (mirrors team/broadcast/integration).
// Written to `domainAuditLogs`. entityType: 'domain'.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'

export const DOMAIN_AUDIT_ACTIONS = [
  'domain.added',
  'domain.verified',
  'domain.failed',
  'domain.removed',
] as const

export type DomainAuditAction = typeof DOMAIN_AUDIT_ACTIONS[number]

export interface DomainAuditParams {
  organizerUid: string
  actorUid:     string
  action:       DomainAuditAction
  domain:       string
  metadata?:    Record<string, unknown>
}

/** Fire-and-forget audit write — never blocks the calling action. */
export async function logDomainAction(params: DomainAuditParams): Promise<void> {
  await adminDb.collection('domainAuditLogs').add({
    organizerUid: params.organizerUid,
    actorUid:     params.actorUid,
    action:       params.action,
    entityType:   'domain',
    entityId:     params.domain,
    metadata:     params.metadata ?? {},
    createdAt:    FieldValue.serverTimestamp(),
  })
}
