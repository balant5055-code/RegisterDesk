import type { Firestore, Query, DocumentData } from 'firebase-admin/firestore'

// RD-AUTH-01 Phase 5 (M-C): the ONE canonical definition of "an organizer account".
//
// Before this, "organizer" was defined two divergent ways: the admin KPI / analytics /
// public-stats counts filtered users by role == 'organizer', while the admin organizers
// list and the support overview treated EVERY users/{uid} doc as an organizer. They
// happen to agree today (firestore.rules pins every client-created users doc to
// role == 'organizer', and admins live in custom claims / ADMIN_UIDS, never as a users
// doc) but they are not backed by a shared predicate, so they can silently drift.
//
// This module is that shared predicate. Counts use organizersQuery(); listings that
// can't push the filter down without a new composite index apply isOrganizer() in
// memory over the scanned page. The role literal is written by createOrganizerProfile
// and the verify-otp self-heal, and enforced by firestore.rules — all reference this
// same value. (users.role is a distinct namespace from team roles in lib/team/types.)

export const ORGANIZER_ROLE = 'organizer' as const

// Server-side (Admin SDK) query for organizer accounts. Callers append
// .count()/.orderBy()/.limit()/.startAfter() as needed — this owns the role filter.
export function organizersQuery(db: Firestore): Query<DocumentData> {
  return db.collection('users').where('role', '==', ORGANIZER_ROLE)
}

// In-memory / single-doc equivalent of organizersQuery's filter, for listings that
// scan raw users pages (where pushing the filter into Firestore would need a new
// composite index). Same definition, so the list and the counts can never diverge.
export function isOrganizer(user: { role?: unknown } | null | undefined): boolean {
  return user?.role === ORGANIZER_ROLE
}
