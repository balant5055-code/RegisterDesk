// Team audit log — organizer-scoped, written to `teamAuditLogs`.
//
// Kept separate from the platform admin audit (`adminAuditLogs`) so organizer
// team actions never mingle with super-admin moderation actions.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'

// RD-TEAM-IMPL-01 — staff lifecycle joins the same log.
//
// Issuing a credential is the most security-relevant thing an organizer does here,
// and until now it was the ONE action that left no trace: the team invite wrote an
// audit row, creating a gate credential wrote none. Same collection, same shape —
// `entityId` is the member-row id in both cases, so a workspace's history reads as
// one sequence regardless of which lifecycle produced the row.
//
// `team.invited` / `team.accepted` are retained as READ-ONLY history: the email
// invitation path that wrote them is gone (RD-TEAM-IMPL-01), but rows written
// before that still exist and must keep parsing.
export const TEAM_AUDIT_ACTIONS = [
  'team.invited',
  'team.accepted',
  'team.role_changed',
  'team.suspended',
  'team.reactivated',
  'team.removed',
  'staff.created',
  'staff.updated',
  'staff.events_changed',
  'staff.password_reset',
  'staff.suspended',
  'staff.reactivated',
  'staff.removed',
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
