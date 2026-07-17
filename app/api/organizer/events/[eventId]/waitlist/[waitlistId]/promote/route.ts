// POST /api/organizer/events/[eventId]/waitlist/[waitlistId]/promote
//
// Transitions status: waiting → invited
// Increments promotedCount counter and sends "spot available" email.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { sendSpotAvailableEmail }    from '@/lib/waitlist/sendSpotAvailableEmail'
import type { WaitlistDocument }     from '@/lib/waitlist/types'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; waitlistId: string }> },
): Promise<NextResponse> {
  const { eventId, waitlistId } = await context.params

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Verify organizer owns this event. Slug lives at eventDetails.seo.urlSlug
  // (publish writes it there) — NOT a top-level `slug` field.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return err('Event not found', 404)
  const seo  = (draftSnap.data() as Record<string, unknown>)?.eventDetails as Record<string, unknown> | undefined
  const slug = (seo?.seo as Record<string, unknown> | undefined)?.urlSlug
  if (typeof slug !== 'string' || !slug) return err('Event not found', 404)

  const docRef  = adminDb.collection('waitlists').doc(waitlistId)
  const docSnap = await docRef.get()
  if (!docSnap.exists) return err('Waitlist entry not found', 404)

  const entry = docSnap.data() as WaitlistDocument

  // Verify this entry belongs to the organizer's event
  if (entry.eventSlug !== slug) return err('Waitlist entry not found', 404)
  if (entry.status !== 'waiting') {
    return err(`Cannot promote entry with status "${entry.status}"`, 409)
  }

  await docRef.update({
    status:    'invited',
    invitedAt: FieldValue.serverTimestamp(),
    invitedBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  })

  // Increment promotedCount counter (fire-and-forget)
  adminDb.collection('waitlistCounters').doc(slug).set({
    eventSlug:     slug,
    promotedCount: FieldValue.increment(1),
    updatedAt:     FieldValue.serverTimestamp(),
  }, { merge: true }).catch(e => console.error('[waitlist] promoted counter failed:', e))

  // Send "spot available" email (fire-and-forget)
  const baseUrl     = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const registerUrl = `${baseUrl}/events/${slug}/register?passId=${entry.passId}`
  sendSpotAvailableEmail(
    { ...entry, status: 'invited', invitedBy: uid },
    registerUrl,
  ).catch(e => console.error('[waitlist] spot-available email failed:', e))

  return NextResponse.json({ success: true })
}
