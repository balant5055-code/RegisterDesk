// GET /api/attendee/certificates — certificates owned by the signed-in attendee.
// Ownership derived from the session email (attendeeEmail query).

import { NextRequest, NextResponse } from 'next/server'
import { requireAttendee }           from '@/lib/attendee/auth'
import { listAttendeeCertificates }  from '@/lib/attendee/data'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireAttendee()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const result = await listAttendeeCertificates(session.normalizedEmail, {
    limit:  parseInt(searchParams.get('limit') ?? '', 10) || undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return NextResponse.json(result)
}
