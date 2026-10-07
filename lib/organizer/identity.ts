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

// ═══ RD-WORKSPACE-OWNERSHIP-01 · EXPLICIT workspace ownership ═════════════════
//
// `users.role === 'organizer'` cannot answer "does this account own a workspace?" —
// see the note above: every sign-in path writes that role, including an invited gate
// operator's first sign-in, so it is true for accounts that own nothing.
//
// Before this field, `lib/team/workspace.ts` inferred ownership from the presence of
// an event draft. That is evidence of a USED workspace, not of owning one, and it is
// false for exactly one account: a brand-new or freshly re-registered organizer who has
// not created anything yet. Such an account holding any active `teamMembers` row was
// silently resolved into the OTHER organizer's workspace, with that membership's
// restricted role — reported as "my new organizer account is missing features".
//
// This marker is the positive fact instead of the inference. It is written ONLY by the
// three organizer profile-creation paths (createOrganizerProfile, the verify-otp
// self-heal, ensureOrganizerProfile), never for a staff credential, and it is
// server-owned: firestore.rules forbids a client from changing it after create.
export const WORKSPACE_OWNER_FIELD = 'workspaceOwner' as const

/**
 * Reads the explicit ownership marker as a THREE-state answer.
 *
 * `true` / `false` are authoritative. `null` means the document predates the marker,
 * and the caller must fall back to the legacy inference rather than treating a missing
 * field as "not an owner" — every account created before this field would otherwise
 * lose its workspace, which is the opposite of the bug being fixed.
 *
 * Pure, and deliberately kept here beside ORGANIZER_ROLE rather than in
 * lib/team/workspace.ts: that module imports the Admin SDK at load, so anything
 * defined there cannot be exercised in the repo's node-environment vitest run.
 */
export function readWorkspaceOwnerMarker(
  user: { workspaceOwner?: unknown } | null | undefined,
): boolean | null {
  const value = user?.workspaceOwner
  return typeof value === 'boolean' ? value : null
}
