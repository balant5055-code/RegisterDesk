// GET /api/organizer/events/[eventId]/identifiers/history?value=...
// Returns the immutable identifier timeline (assigned/released/swapped/reserved/
// blocked/retired/consumed/reused/restored). Calls the engine. Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { getIdentifierHistory } from '@/lib/identifiers/engine'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'

export const dynamic = 'force-dynamic'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const value = (req.nextUrl.searchParams.get('value') ?? '').trim()
  if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })

  const entries = await getIdentifierHistory(scope.slug, value)
  return NextResponse.json({
    value,
    entries: entries.map(e => ({
      action:         e.action,
      actor:          e.actor,
      registrationId: e.registrationId,
      previousOwner:  e.previousOwner,
      newOwner:       e.newOwner,
      reason:         e.reason,
      timestamp:      tsToISO(e.timestamp),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
