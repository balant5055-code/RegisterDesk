// /dashboard/events/[eventId]/checkin
//
// Organizer check-in page — full-screen interface for scanning / entering
// ticket codes at the event gate.  Client-side auth via Firebase Auth.

import type { Metadata } from 'next'
import CheckInPageClient  from './CheckInPageClient'

export const metadata: Metadata = {
  title:  'Check-in – RegisterDesk',
  robots: { index: false },
}

type PageProps = { params: Promise<{ eventId: string }> }

export default async function CheckInPage({ params }: PageProps) {
  const { eventId } = await params
  return <CheckInPageClient eventId={eventId} />
}
