// GET /api/attendee/donations — the signed-in attendee's own donations.
// Ownership derived from the session email (donorEmail query).

import { NextRequest, NextResponse } from 'next/server'
import { requireAttendee }           from '@/lib/attendee/auth'
import { listAttendeeDonations }     from '@/lib/attendee/data'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireAttendee()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const result = await listAttendeeDonations(session.normalizedEmail, {
    limit:  parseInt(searchParams.get('limit') ?? '', 10) || undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return NextResponse.json(result)
}
