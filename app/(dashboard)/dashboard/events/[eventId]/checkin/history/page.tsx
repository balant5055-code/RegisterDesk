// /dashboard/events/[eventId]/checkin/history — RD-CHECKIN-04
//
// A shell only. Authorization lives in
// GET /api/organizer/events/[eventId]/checkin/history, which requires the
// `registrations` permission and re-derives the event from the route path — so a
// caller who reaches this page without that grant sees the route's refusal, not
// a history.

import type { Metadata } from 'next'
import HistoryClient from './HistoryClient'

export const metadata: Metadata = {
  title:  'Check-in history – RegisterDesk',
  robots: { index: false },
}

export default async function CheckinHistoryPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return <HistoryClient eventId={eventId} />
}
