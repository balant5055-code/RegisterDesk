// GET /api/events — public event discovery API
// Returns published events and aggregate platform stats.

import { NextRequest, NextResponse } from 'next/server'
import { listPublishedEvents }       from '@/lib/firebase/firestore/publicEvents'

// Re-export types so client components can `import type { PublicEventCard }` from this route.
export type { PublicEventCard, PlatformStats, DiscoveryData as EventsDiscoveryResponse } from '@/lib/firebase/firestore/publicEvents'

export async function GET(_req: NextRequest) {
  try {
    const data = await listPublishedEvents(48)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    })
  } catch (err) {
    console.error('[GET /api/events]', err)
    return NextResponse.json(
      { events: [], stats: { totalEvents: 0, totalRegistrations: 0, totalCities: 0 } },
      { status: 500 },
    )
  }
}
