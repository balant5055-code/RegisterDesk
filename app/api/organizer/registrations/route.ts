// GET /api/organizer/registrations
//
// Returns all registration records for the authenticated organizer across all
// events.  Stats are always computed over the full set; the caller filters
// client-side using the URL query param (?status=confirmed|cancelled|pending).
//
// Optional query params:
//   eventId — draftId of an organizer event; when present, results are scoped
//             to that event only.  Omit to return registrations for all events.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import type { RegistrationDocument } from '@/lib/registrations/types'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

export interface AllRegistrationsResponse {
  registrations: SerializedRegistration[]
  stats: {
    total:      number
    confirmed:  number
    cancelled:  number
    pending:    number
    waitlisted: number
  }
}

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

const EMPTY_RESPONSE: AllRegistrationsResponse = {
  registrations: [],
  stats: { total: 0, confirmed: 0, cancelled: 0, pending: 0, waitlisted: 0 },
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Optional event filter ──────────────────────────────────────────────────
  // Resolve the eventId (draftId) to its URL slug, which is the field stored
  // on registration documents.  Ownership is verified implicitly: the draft
  // must live under users/{uid}/eventDrafts/{eventId}.
  const eventId     = req.nextUrl.searchParams.get('eventId') ?? null
  let   slugFilter: string | null = null

  if (eventId) {
    const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
    if (!draftSnap.exists) {
      // eventId not found under this organizer's drafts — return empty safely
      return NextResponse.json(EMPTY_RESPONSE satisfies AllRegistrationsResponse)
    }
    const draft      = draftSnap.data() as Record<string, unknown>
    const rawDetails = draft.eventDetails as Record<string, unknown> | null
    const rawSeo     = rawDetails?.seo   as Record<string, unknown> | null
    const slug       = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug : null
    // Draft events with no published slug have no registrations yet
    if (!slug) return NextResponse.json(EMPTY_RESPONSE satisfies AllRegistrationsResponse)
    slugFilter = slug
  }

  // ── Build Firestore query ──────────────────────────────────────────────────
  // Fetch all registrations for this organizer (max 300, newest-first)
  let baseQuery = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)

  if (slugFilter) {
    baseQuery = baseQuery.where('eventSlug', '==', slugFilter)
  }

  const snap = await baseQuery.limit(300).get()

  const registrations: SerializedRegistration[] = snap.docs
    .map(doc => {
      const data = doc.data() as RegistrationDocument
      return {
        ...data,
        registeredAt: toISO(data.registeredAt),
        updatedAt:    toISO(data.updatedAt),
        emailSentAt:  toISO(data.emailSentAt),
        checkedInAt:  toISO(data.checkedInAt),
      } as SerializedRegistration
    })
    .sort((a, b) => {
      const at = a.registeredAt ? new Date(a.registeredAt).getTime() : 0
      const bt = b.registeredAt ? new Date(b.registeredAt).getTime() : 0
      return bt - at
    })

  const stats = {
    total:      registrations.length,
    confirmed:  registrations.filter(r => r.status === 'confirmed').length,
    cancelled:  registrations.filter(r => r.status === 'cancelled').length,
    pending:    registrations.filter(r => r.status === 'pending').length,
    waitlisted: registrations.filter(r => r.status === 'waitlisted').length,
  }

  return NextResponse.json({ registrations, stats } satisfies AllRegistrationsResponse)
}
