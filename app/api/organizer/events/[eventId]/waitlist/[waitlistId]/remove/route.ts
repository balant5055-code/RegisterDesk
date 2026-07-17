// POST /api/organizer/events/[eventId]/waitlist/[waitlistId]/remove
//
// Transitions any non-removed entry to status: removed.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
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

  // Slug lives at eventDetails.seo.urlSlug (publish writes it there) — NOT a
  // top-level `slug` field.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return err('Event not found', 404)
  const seo  = (draftSnap.data() as Record<string, unknown>)?.eventDetails as Record<string, unknown> | undefined
  const slug = (seo?.seo as Record<string, unknown> | undefined)?.urlSlug
  if (typeof slug !== 'string' || !slug) return err('Event not found', 404)

  const docRef  = adminDb.collection('waitlists').doc(waitlistId)
  const docSnap = await docRef.get()
  if (!docSnap.exists) return err('Waitlist entry not found', 404)

  const entry = docSnap.data() as WaitlistDocument
  if (entry.eventSlug !== slug) return err('Waitlist entry not found', 404)
  if (entry.status === 'removed') {
    return err('Entry is already removed', 409)
  }

  await docRef.update({
    status:    'removed',
    updatedAt: FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ success: true })
}
