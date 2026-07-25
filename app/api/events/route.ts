// GET /api/events — public event discovery API
// Returns one page of published events (cursor-paginated) + aggregate stats.
// Query params (all additive/optional): limit, cursor, search, category, city, free, online, date.
// Filtering runs server-side over the WHOLE published set (RD-DISCOVERY-01 Phase 1 / D-C1).

import { NextRequest, NextResponse } from 'next/server'
import { listPublishedEvents }       from '@/lib/firebase/firestore/publicEvents'

// Re-export types so client components can `import type { PublicEventCard }` from this route.
export type { PublicEventCard, PlatformStats, DiscoveryData as EventsDiscoveryResponse } from '@/lib/firebase/firestore/publicEvents'

export async function GET(req: NextRequest) {
  try {
    const sp  = req.nextUrl.searchParams
    const num = (v: string | null): number | undefined => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined }
    const tri = (v: string | null): boolean | null => v === 'true' ? true : v === 'false' ? false : null
    const dateParam = sp.get('date')
    const data = await listPublishedEvents({
      limit:    num(sp.get('limit')),
      cursor:   sp.get('cursor'),
      search:   sp.get('search')   ?? undefined,
      category: sp.get('category') ?? undefined,
      city:     sp.get('city')     ?? undefined,
      free:     tri(sp.get('free')),
      online:   tri(sp.get('online')),
      date:     (dateParam === 'today' || dateParam === 'week' || dateParam === 'month') ? dateParam : undefined,
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
