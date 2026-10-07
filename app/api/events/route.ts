// GET /api/events — public event discovery API
// Returns one page of published events (cursor-paginated) + aggregate stats.
// Query params (all additive/optional): limit, cursor, search, category, city, state, free,
// online, venue, date, dateFrom, dateTo.
// Filtering runs server-side over the WHOLE published set (RD-DISCOVERY-01 Phase 1 / D-C1).

import { NextRequest, NextResponse } from 'next/server'
import { listPublishedEvents, isDateRangeKey } from '@/lib/firebase/firestore/publicEvents'

// Re-export types so client components can `import type { PublicEventCard }` from this route.
export type { PublicEventCard, PlatformStats, DiscoveryData as EventsDiscoveryResponse } from '@/lib/firebase/firestore/publicEvents'

export async function GET(req: NextRequest) {
  try {
    const sp  = req.nextUrl.searchParams
    const num = (v: string | null): number | undefined => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined }
    const tri = (v: string | null): boolean | null => v === 'true' ? true : v === 'false' ? false : null
    // YYYY-MM-DD only — anything else is dropped rather than passed through as a bare string.
    const day = (v: string | null): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
    // A cursor is a DOCUMENT ID, and it reaches `collection.doc(cursor)` downstream. A value
    // containing '/' is therefore read as a document PATH rather than an id, and Firestore
    // throws on an odd segment count. Anything that is not a plain slug is rejected to null,
    // which starts from page one instead of surfacing the input in an error.
    const slug = (v: string | null): string | null => (v && /^[A-Za-z0-9_-]{1,200}$/.test(v) ? v : null)
    const venueParam = sp.get('venue')
    const dateParam  = sp.get('date')
    const data = await listPublishedEvents({
      limit:    num(sp.get('limit')),
      cursor:   slug(sp.get('cursor')),
      search:   sp.get('search')   ?? undefined,
      category: sp.get('category') ?? undefined,
      city:     sp.get('city')     ?? undefined,
      state:    sp.get('state')    ?? undefined,
      free:     tri(sp.get('free')),
      online:   tri(sp.get('online')),
      venue:    (venueParam === 'physical' || venueParam === 'online' || venueParam === 'hybrid') ? venueParam : undefined,
      date:     isDateRangeKey(dateParam) ? dateParam : undefined,
      dateFrom: day(sp.get('dateFrom')),
      dateTo:   day(sp.get('dateTo')),
      // Opt out of the platform aggregates. ONLY the exact string '0' disables them, so any
      // other value — including the parameter being absent — keeps the previous behaviour.
      withStats: sp.get('stats') === '0' ? false : undefined,
    })
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    })
  } catch (err) {
    console.error('[GET /api/events]', err)
    return NextResponse.json(
      { events: [], stats: { totalEvents: 0, totalRegistrations: 0, totalCities: 0, totalOrganizers: 0 }, nextCursor: null },
      { status: 500 },
    )
  }
}
