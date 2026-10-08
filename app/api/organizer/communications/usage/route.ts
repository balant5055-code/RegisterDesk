// GET /api/organizer/communications/usage?eventId=<draftId> — RD-COMMS-P1
//
// Communication Center › Usage: ONE event's communication capacity (WhatsApp + certificates:
// purchased / in progress / used / returned / remaining), email (free) and the event's recent
// broadcasts. READ-ONLY — no purchase, no top-up; more capacity is bought on License & Services.
//
// Auth: the canonical event-scoped check (authorizeEvent) with the `broadcasts` permission — the
// Communication Center's permission — so an event-restricted team member sees only their events.
// The draft is read under the WORKSPACE's own path, so another organizer's event id is a 404.
// The legacy communication balance is money: it is included only for `wallet` holders.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeEvent } from '@/lib/team/workspace'
import { captureError } from '@/lib/monitoring/sentry'
import { getEventCommunicationUsage } from '@/lib/communications/usage'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const eventId = req.nextUrl.searchParams.get('eventId') ?? ''
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
    return NextResponse.json({ error: 'Select an event.' }, { status: 400, headers: NO_STORE })
  }
  const authz = await authorizeEvent(req, 'broadcasts', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  try {
    const usage = await getEventCommunicationUsage(authz.workspaceUid, eventId, {
      includeLegacyBalance: authz.permissions.includes('wallet'),
    })
    if (!usage) return NextResponse.json({ error: 'Event not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json(usage, { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'organizer.communications.usage' })
    return NextResponse.json({ error: 'Could not load usage. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
