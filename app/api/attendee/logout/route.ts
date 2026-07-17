// POST /api/attendee/logout — invalidates the session record and clears the cookie.

import { NextResponse }            from 'next/server'
import { destroyAttendeeSession } from '@/lib/attendee/auth'

export async function POST(): Promise<NextResponse> {
  await destroyAttendeeSession()
  return NextResponse.json({ success: true })
}
