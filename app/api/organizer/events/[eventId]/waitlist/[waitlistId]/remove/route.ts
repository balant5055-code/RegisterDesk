// POST /api/organizer/events/[eventId]/waitlist/[waitlistId]/remove
//
// Transitions any non-removed entry to status: removed.
//
// ═══ RD-EVENT-15 ═════════════════════════════════════════════════════════════
// Same two corrections as the promote route: the status check and the status change are
// one transaction (so two clicks cannot both "succeed" on an entry that only changes
// once), and the response reports the resulting status so the client can update the row
// it holds instead of refetching the whole queue.
//
// Removal is deliberately allowed on a CLOSED event, unlike promotion. Promoting mails
// someone a registration link the gate would refuse; removing is a records correction
// that stays valid whatever the lifecycle says. Nothing is sent to the person.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import type { WaitlistDocument }     from '@/lib/waitlist/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

export interface RemoveResponse {
  success: true
  status:  'removed'
  /** What it was before, so the client can word an undo-less confirmation honestly. */
  previousStatus: 'waiting' | 'invited'
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/**
 * Reads the caller's draft, tolerating an eventId that is not a legal document id.
 *
 * `adminDb.doc()` THROWS on a path with the wrong number of segments, so a probe like
 * `..%2F..%2Fadmin` used to escape as an unhandled 500 carrying a Next digest. An id that
 * cannot name a document cannot name an event the caller owns, so it is a 404 — the same
 * answer, in the same words, as an event that belongs to somebody else.
 */
async function readOwnDraft(uid: string, eventId: string) {
  try {
    return await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  } catch {
    return null
  }
}


/** A document id containing a slash is not an id — `.doc()` would throw on it. */
function isDocId(v: string): boolean {
  return v.length > 0 && v.length <= 1500 && !v.includes('/')
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; waitlistId: string }> },
): Promise<NextResponse> {
  const { eventId, waitlistId } = await context.params

  if (!isDocId(waitlistId)) return err('Waitlist entry not found', 404)

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  // Slug lives at eventDetails.seo.urlSlug (publish writes it there) — NOT a
  // top-level `slug` field.
  const draftSnap = await readOwnDraft(uid, eventId)
  if (!draftSnap?.exists) return err('Event not found', 404)
  // RD-CE-FIX C1 · only a slug proven to be THIS workspace's live event (the pointer is client-writable).
  const slug    = await resolveOwnedEventSlug(uid, eventId, draftSnap.data() as Record<string, unknown>)
  if (!slug) return err('Event not found', 404)

  const docRef = adminDb.collection('waitlists').doc(waitlistId)

  try {
    const previousStatus = await adminDb.runTransaction(async txn => {
      const snap = await txn.get(docRef)
      if (!snap.exists) throw new HttpError('Waitlist entry not found', 404)

      const data = snap.data() as WaitlistDocument
      // Re-checked against the entry itself, so an id from another event is never
      // actionable just because the caller owns some event.
      if (data.eventSlug !== slug) throw new HttpError('Waitlist entry not found', 404)
      if (data.status === 'removed') throw new HttpError('This person has already been removed.', 409)

      txn.update(docRef, {
        status:    'removed',
        updatedAt: FieldValue.serverTimestamp(),
      })
      return data.status === 'invited' ? 'invited' as const : 'waiting' as const
    })

    const body: RemoveResponse = { success: true, status: 'removed', previousStatus }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.status)
    return err('This person could not be removed from the waitlist. Please try again.', 503)
  }
}
