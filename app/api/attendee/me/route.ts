// GET /api/attendee/me — current attendee identity from the session cookie.

import { NextResponse }          from 'next/server'
import { verifyAttendeeSession } from '@/lib/attendee/auth'

export async function GET(): Promise<NextResponse> {
  const session = await verifyAttendeeSession()
  if (!session) {
    return NextResponse.json({ authenticated: false })
  }
  return NextResponse.json({ authenticated: true, email: session.email })
}
