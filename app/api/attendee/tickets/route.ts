// GET /api/attendee/tickets — downloadable tickets for the signed-in attendee.
// Ownership derived from the session email; ticket PDF URLs are signed per
// registration. No ticket belonging to another attendee can be returned.

import { NextRequest, NextResponse } from 'next/server'
import { requireAttendee }           from '@/lib/attendee/auth'
import { listAttendeeTickets }       from '@/lib/attendee/data'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireAttendee()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const result = await listAttendeeTickets(session.normalizedEmail, {
    limit:  parseInt(searchParams.get('limit') ?? '', 10) || undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return NextResponse.json(result)
}
