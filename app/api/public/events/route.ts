// GET /api/public/events?limit=&cursor=
//
// Public API — organizer API key (events.read). Lists the organizer's published
// events, scoped to the key's organizer, cursor-paginated by slug.

import { NextRequest, NextResponse } from 'next/server'
import { FieldPath }                 from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authenticateApiKey }        from '@/lib/integrations/apiKeys'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}
function str(v: unknown): string | null { return typeof v === 'string' ? v : null }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateApiKey(req, 'events.read')
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: auth.headers })

  const sp     = req.nextUrl.searchParams
  const limit  = Math.min(Math.max(parseInt(sp.get('limit') ?? '', 10) || 50, 1), 100)
  const cursor = sp.get('cursor')?.trim()

  let q = adminDb.collection('events')
    .where('uid', '==', auth.organizerUid)
    .orderBy(FieldPath.documentId())
    .limit(limit + 1) as FirebaseFirestore.Query
  if (cursor) q = q.startAfter(cursor) as FirebaseFirestore.Query

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  const data = pageDocs.map(doc => {
    const e       = doc.data() as Record<string, unknown>
    const details = (e.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info as Record<string, unknown>) ?? {}
    const sched   = (details.schedule as Record<string, unknown>) ?? {}
    return {
      slug:            doc.id,
      name:            str(info.name) ?? '',
      eventType:       str(e.eventType),
      lifecycleStatus: str(e.lifecycleStatus) ?? 'published',
      startDate:       str(sched.startDate),
      endDate:         str(sched.endDate),
      totalCapacity:   typeof e.totalCapacity === 'number' ? e.totalCapacity : null,
      publishedAt:     tsToISO(e.publishedAt),
    }
  })

  return NextResponse.json(
    { data, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
