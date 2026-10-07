// POST /api/organizer/events/[eventId]/waitlist/[waitlistId]/promote
//
// Transitions status: waiting → invited, then emails the person a registration link.
//
// ═══ RD-EVENT-15 · WHAT THIS ROUTE USED TO ALLOW ═════════════════════════════
//
//  1. A DOUBLE PROMOTION. The status was read, then written, with nothing between them:
//
//         const entry = docSnap.data()
//         if (entry.status !== 'waiting') return 409
//         await docRef.update({ status: 'invited', … })
//
//     Two clicks in two tabs — or one operator and one teammate — both read `waiting`,
//     both wrote `invited`, both incremented `promotedCount` and both sent the email. The
//     read and the write are now the same transaction, so the second one loses and gets
//     the 409 it should always have received.
//
//  2. PROMOTION OUT OF A CLOSED EVENT. There was no lifecycle check at all, so an
//     organizer could email "a spot has opened, register now" for a CANCELLED event —
//     and `checkRegistrationGate` would then refuse the person at the link. The event
//     must still be accepting registrations for an invitation to lead anywhere.
//
//  3. A SILENT EMAIL FAILURE. The send was fire-and-forget behind `.catch(console.error)`
//     and the response said `{ success: true }` either way, so "promoted" and "promoted
//     but they were never told" were the same answer. The send is now awaited and its
//     outcome reported — the promotion still stands, because the status change is the
//     durable part and re-sending is not something this route can do idempotently.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { sendSpotAvailableEmail }    from '@/lib/waitlist/sendSpotAvailableEmail'
import { getEmailAppUrl }            from '@/lib/email/appUrl'
import { eventAcceptsRegistrations } from '@/lib/waitlist/waitlistView'
import type { WaitlistDocument }     from '@/lib/waitlist/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

export interface PromoteResponse {
  success: true
  status:  'invited'
  /** false = the status changed but the "a spot is available" email did not go out. */
  notified: boolean
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

  // Verify the caller owns this event. Slug lives at eventDetails.seo.urlSlug (publish
  // writes it there) — NOT a top-level `slug` field.
  const draftSnap = await readOwnDraft(uid, eventId)
  if (!draftSnap?.exists) return err('Event not found', 404)
  // RD-CE-FIX C1 · only a slug proven to be THIS workspace's live event (the pointer is client-writable).
  const slug    = await resolveOwnedEventSlug(uid, eventId, draftSnap.data() as Record<string, unknown>)
  if (!slug) return err('Event not found', 404)

  const docRef   = adminDb.collection('waitlists').doc(waitlistId)
  const eventRef = adminDb.collection('events').doc(slug)

  let entry: WaitlistDocument
  try {
    // ── The status check and the status change are ONE transaction ──────────
    entry = await adminDb.runTransaction(async txn => {
      const [docSnap, eventSnap] = await Promise.all([txn.get(docRef), txn.get(eventRef)])

      if (!docSnap.exists) throw new HttpError('Waitlist entry not found', 404)
      const data = docSnap.data() as WaitlistDocument

      // Ownership is re-checked against the entry itself: a waitlist id from another
      // event must not become actionable just because the caller owns SOME event.
      if (data.eventSlug !== slug) throw new HttpError('Waitlist entry not found', 404)

      if (data.status === 'invited') throw new HttpError('This person has already been invited.', 409)
      if (data.status === 'removed') throw new HttpError('This person was removed from the waitlist.', 409)
      if (data.status !== 'waiting') throw new HttpError('This entry cannot be invited.', 409)

      // The lifecycle is read from the PUBLISHED document, which is the same source the
      // registration gate uses — so an invitation is only ever sent for an event that
      // would actually accept the resulting registration.
      const lifecycle = eventSnap.exists
        ? (eventSnap.data() as Record<string, unknown>).lifecycleStatus
        : null
      if (!eventAcceptsRegistrations(typeof lifecycle === 'string' ? lifecycle : null)) {
        throw new HttpError(
          'This event is not accepting registrations, so an invitation would lead nowhere.',
          409,
        )
      }

      txn.update(docRef, {
        status:    'invited',
        invitedAt: FieldValue.serverTimestamp(),
        invitedBy: uid,
        updatedAt: FieldValue.serverTimestamp(),
      })

      // Inside the transaction, so a promotion that loses the race cannot leave the
      // counter ahead of the entries it is supposed to count.
      txn.set(adminDb.collection('waitlistCounters').doc(slug), {
        eventSlug:     slug,
        promotedCount: FieldValue.increment(1),
        updatedAt:     FieldValue.serverTimestamp(),
      }, { merge: true })

      return data
    })
  } catch (e) {
    if (e instanceof HttpError) return err(e.message, e.status)
    return err('The invitation could not be sent. Please try again.', 503)
  }

  // ── Notify ────────────────────────────────────────────────────────────────
  // Awaited, so "invited but not told" is reportable. The promotion is NOT rolled back
  // on a send failure: the status change is the durable record an organizer acts on, and
  // undoing it would make the entry promotable again and risk a duplicate email.
  let notified = false
  try {
    const registerUrl = `${getEmailAppUrl()}/events/${slug}/register?passId=${encodeURIComponent(entry.passId)}`
    await sendSpotAvailableEmail({ ...entry, status: 'invited', invitedBy: uid }, registerUrl)
    notified = true
  } catch (e) {
    console.error('[waitlist] spot-available email failed:', e)
  }

  const body: PromoteResponse = { success: true, status: 'invited', notified }
  return NextResponse.json(body)
}

/** Carries an HTTP status out of the transaction callback. */
class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
