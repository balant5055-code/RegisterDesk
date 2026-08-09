// RD-MEDIA-01 · Route authorization + event resolution — SERVER ONLY.
//
// THE single gate for every Media Studio route.
//
// ─── Why `events` and not a new permission ───────────────────────────────────
// Media belongs to an event. Anyone trusted to manage an event's content is trusted to
// manage its photos, so Media Studio reuses the EXISTING `events` permission and adds
// nothing to `ALL_PERMISSIONS`. Owner / admin / manager keep working exactly as they do
// today, and the production RBAC matrix is untouched — the doctrine every prior sprint
// followed.

import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'

export type MediaAuthz =
  | { ok: true;  callerUid: string; workspaceUid: string }
  | { ok: false; status: number; error: string }

export async function authorizeMedia(req: Request): Promise<MediaAuthz> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error }
  return { ok: true, callerUid: authz.callerUid, workspaceUid: authz.workspaceUid }
}

export interface ResolvedEvent {
  eventId:   string
  eventSlug: string
  eventName: string
}

export type ResolveEventOutcome =
  | { ok: true;  event: ResolvedEvent }
  | { ok: false; status: number; error: string }

/**
 * Resolves an eventId to its published slug and proves ownership.
 *
 * Ownership is the PATH — `users/{workspaceUid}/eventDrafts/{eventId}`. An event the
 * workspace does not own simply does not exist there, so it 404s without leaking whether it
 * exists elsewhere. This is the canonical shape used across the platform
 * (`lib/registrations/importContext.ts:38-45`).
 *
 * Media Studio needs only the event — not a pass — so it reads the draft directly rather
 * than routing through Race Operations' `resolveRace`, which requires a passId. Borrowing
 * that resolver with a sentinel pass would mean interpreting a "race not found" error as
 * success, which is the kind of cleverness that breaks silently later.
 *
 * The slug matters beyond identity: it is the storage path segment
 * (`events/{eventSlug}/photos/...`), so an event without one has nowhere to put photos.
 */
export async function resolveOwnedEvent(
  workspaceUid: string,
  eventId:      string,
): Promise<ResolveEventOutcome> {
  const snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return { ok: false, status: 404, error: 'Event not found' }

  const draft   = snap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}

  const eventSlug = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!eventSlug) {
    return {
      ok: false, status: 409,
      error: 'Publish this event before uploading media — photos are stored under its public URL.',
    }
  }

  return {
    ok: true,
    event: {
      eventId,
      eventSlug,
      eventName: typeof info.name === 'string' ? info.name : 'Untitled Event',
    },
  }
}
