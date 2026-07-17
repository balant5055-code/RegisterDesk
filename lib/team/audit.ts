// Team audit log — organizer-scoped, written to `teamAuditLogs`.
//
// Kept separate from the platform admin audit (`adminAuditLogs`) so organizer
// team actions never mingle with super-admin moderation actions.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'

export const TEAM_AUDIT_ACTIONS = [
  'team.invited',
  'team.accepted',
  'team.role_changed',
  'team.suspended',
  'team.reactivated',
  'team.removed',
] as const

export type TeamAuditAction = typeof TEAM_AUDIT_ACTIONS[number]

export interface TeamAuditParams {
  organizerUid: string                       // workspace the action happened in
  actorUid:     string                       // who performed it
  action:       TeamAuditAction
  memberId:     string                       // the team_member entity id
  metadata?:    Record<string, unknown>
}

const TEAM_AUDIT_COLLECTION = 'teamAuditLogs'

/** Fire-and-forget audit write — never blocks or fails the calling action. */
export async function logTeamAction(params: TeamAuditParams): Promise<void> {
  await adminDb.collection(TEAM_AUDIT_COLLECTION).add({
    organizerUid: params.organizerUid,
    actorUid:     params.actorUid,
    action:       params.action,
    entityType:   'team_member',
    entityId:     params.memberId,
    metadata:     params.metadata ?? {},
    createdAt:    FieldValue.serverTimestamp(),
  })
}
