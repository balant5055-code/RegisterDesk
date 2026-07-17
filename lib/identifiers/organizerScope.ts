// Phase H.3 — Shared organizer scope resolution for the identifier API layer.
//
// One place that: (1) authenticates + enforces the `participants` permission,
// (2) resolves eventId (draft id) → eventSlug within the caller's workspace, and
// (3) guards registration-targeting actions against cross-event / cross-organizer
// access. Every identifier route reuses this — no duplicated auth/scope logic.

import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'

export type ScopeResult =
  | { ok: true; slug: string; workspaceUid: string; callerUid: string }
  | { ok: false; status: number; error: string }

/** Auth (`participants`) + workspace-scoped eventId→slug resolution. */
export async function resolveIdentifierScope(req: Request, eventId: string): Promise<ScopeResult> {
  const authz = await authorizeWorkspace(req, 'participants')
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error }

  const uid = authz.workspaceUid
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return { ok: false, status: 404, error: 'Event not found' }

  const d   = draftSnap.data() as Record<string, unknown>
  const seo = (d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown> | undefined
  const slug = typeof seo?.urlSlug === 'string' ? seo.urlSlug : ''
  if (!slug) return { ok: false, status: 400, error: 'Event not published' }

  return { ok: true, slug, workspaceUid: uid, callerUid: authz.callerUid }
}

export type RegScopeResult = { ok: true } | { ok: false; status: number; error: string }

/** Confirms a registration belongs to this workspace AND this event. */
export async function assertRegistrationInScope(
  registrationId: string, workspaceUid: string, slug: string,
): Promise<RegScopeResult> {
  if (!registrationId) return { ok: false, status: 400, error: 'registrationId is required' }
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) return { ok: false, status: 404, error: 'Registration not found' }
  const r = snap.data() as Record<string, unknown>
  if (r.organizerUid !== workspaceUid || r.eventSlug !== slug) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true }
}
