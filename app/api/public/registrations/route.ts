// GET /api/public/registrations?limit=&cursor=&eventSlug=
//
// Public API — authenticated by an organizer API key (registrations.read).
// Scoped strictly to the key's organizer; cursor-paginated. No cross-organizer
// access is possible: the query is filtered by the key's organizerUid.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authenticateApiKey }        from '@/lib/integrations/apiKeys'
import type { RegistrationDocument } from '@/lib/registrations/types'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateApiKey(req, 'registrations.read')
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: auth.headers })

  const sp     = req.nextUrl.searchParams
  const limit  = Math.min(Math.max(parseInt(sp.get('limit') ?? '', 10) || 50, 1), 100)
  const cursor = sp.get('cursor')?.trim()
  const eventSlug = sp.get('eventSlug')?.trim()

  let q = adminDb.collection('registrations')
    .where('organizerUid', '==', auth.organizerUid) as FirebaseFirestore.Query
  if (eventSlug) q = q.where('eventSlug', '==', eventSlug)
  q = q.orderBy('registeredAt', 'desc').limit(limit + 1)

  if (cursor) {
    const curSnap = await adminDb.collection('registrations').doc(cursor).get()
    // Cursor must belong to this organizer — never paginate into another's data.
    if (curSnap.exists && (curSnap.data() as RegistrationDocument).organizerUid === auth.organizerUid) {
      q = q.startAfter(curSnap) as FirebaseFirestore.Query
    }
  }

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  const data = pageDocs.map(doc => {
    const r = doc.data() as RegistrationDocument
    return {
      id:             doc.id,
      eventSlug:      r.eventSlug,
      eventName:      r.eventName,
      passName:       r.passName,
      status:         r.status,
      paymentStatus:  r.paymentStatus,
      amountPaise:    r.amount,
      ticketCode:     r.ticketCode,
      checkedIn:      Boolean(r.checkedIn),
      attendee:       { name: r.attendee?.name ?? '', email: r.attendee?.email ?? '', phone: r.attendee?.phone ?? null },
      registeredAt:   tsToISO(r.registeredAt),
    }
  })

  return NextResponse.json(
    { data, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
