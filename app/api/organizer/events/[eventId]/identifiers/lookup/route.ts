// GET /api/organizer/events/[eventId]/identifiers/lookup?value=...
// Looks up a single identifier's lock state. Calls the engine. Read-only.
// Slug-scoped (lock doc id is event-scoped) → no cross-event access.

import { NextRequest, NextResponse } from 'next/server'
import { lookupIdentifier } from '@/lib/identifiers/engine'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const value = (req.nextUrl.searchParams.get('value') ?? '').trim()
  if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })

  const result = await lookupIdentifier(scope.slug, value)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
