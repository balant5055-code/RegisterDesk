// GET /api/checkin/cache?slug=<eventSlug>
//
// Returns a lean attendee list for ONE event, for the operator's device to cache
// in IndexedDB so check-in can continue offline.
//
// Security:
//   1. Token verified server-side via Firebase Admin Auth.
//   2. The query is scoped to organizerUid == authenticated uid AND eventSlug.
//      Ownership is therefore enforced by the query itself — passing a slug owned
//      by another organizer returns zero rows, never another org's attendees.
//   3. Only the minimal fields needed for offline validation are returned.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                    from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { requireFeature }             from '@/lib/licensing/workspaceEntitlements'
import type { RegistrationDocument }  from '@/lib/registrations/types'

// Hard cap — Phase 1 caches a single event's list in one request. Events larger
// than this are reported via `truncated` so the UI can warn the operator.
const MAX_CACHE = 5000

export interface CachedAttendee {
  registrationId: string
  ticketCode:     string
  attendeeName:   string
  passName:       string
  eventSlug:      string
  status:         string
  paymentStatus:  string
  checkedIn:      boolean
  checkedInAt:    string | null
}

export interface CacheResponse {
  eventSlug:  string
  attendees:  CachedAttendee[]
  count:      number
  truncated:  boolean
  fetchedAt:  string
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Plan gate — offline check-in (attendee cache) is a paid feature.
  const feat = await requireFeature(uid, 'offlineCheckin')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  const slug = req.nextUrl.searchParams.get('slug')?.trim()
  if (!slug) return NextResponse.json({ error: 'MISSING_SLUG' }, { status: 400 })

  // Ownership enforced by the compound filter (organizerUid + eventSlug) — reuses
  // the existing (organizerUid, eventSlug) composite index.
  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug', '==', slug)
    .limit(MAX_CACHE + 1)
    .get()

  const truncated = snap.docs.length > MAX_CACHE
  const docs      = truncated ? snap.docs.slice(0, MAX_CACHE) : snap.docs

  const attendees: CachedAttendee[] = docs
    .map(doc => {
      const d = doc.data() as RegistrationDocument
      return {
        registrationId: doc.id,
        ticketCode:     d.ticketCode ?? '',
        attendeeName:   d.attendee?.name ?? '',
        passName:       d.passName ?? '',
        eventSlug:      d.eventSlug ?? slug,
        status:         d.status,
        paymentStatus:  d.paymentStatus,
        checkedIn:      Boolean(d.checkedIn),
        checkedInAt:    tsToISO(d.checkedInAt),
      }
    })
    // Only tickets that can actually be scanned belong in the offline cache.
    .filter(a => a.ticketCode)

  const body: CacheResponse = {
    eventSlug: slug,
    attendees,
    count:     attendees.length,
    truncated,
    fetchedAt: new Date().toISOString(),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
