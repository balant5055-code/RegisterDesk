// GET /api/organizer/event-types — RD-EVENT-TYPES-01 · which event types the wizard may offer.
//   → { availability: { [eventTypeId]: boolean } }
//
// Display only: the routes that create, retype, duplicate or first-submit an event enforce the same
// switches themselves (lib/events/eventTypeAvailabilityServer.ts), whatever a client sends.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventTypeAvailability } from '@/lib/events/eventTypeAvailabilityServer'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { availability } = await getEventTypeAvailability()
  return NextResponse.json({ availability }, { headers: { 'Cache-Control': 'no-store' } })
}
