// Resolve + ownership-check an organizer event by its draftId ([eventId] in routes).
// Mirrors the existing event-scoped route pattern: the event lives at
// users/{workspaceUid}/eventDrafts/{eventId}; the public slug is in eventDetails.seo.urlSlug.

import { adminDb } from '@/lib/firebase/admin'

export interface OwnedEvent { slug: string; eventName: string }

export async function resolveOwnedEvent(workspaceUid: string, eventId: string): Promise<OwnedEvent | null> {
  const snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  const d = snap.data() as { eventDetails?: { seo?: { urlSlug?: unknown }; info?: { name?: unknown } } }
  const slug = d.eventDetails?.seo?.urlSlug
  if (typeof slug !== 'string' || !slug) return null
  const name = typeof d.eventDetails?.info?.name === 'string' ? d.eventDetails.info.name : 'Event'
  return { slug, eventName: name }
}
