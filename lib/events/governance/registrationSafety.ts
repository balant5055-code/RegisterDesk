// Publish Governance — registration safety (EA-4 S1). Server-only.
//
// Detects whether a published event already has attendee activity, via the O(1)
// registrationCounters doc (reused — no scan). totalCount / checkedInCount > 0
// implies registrations exist (and therefore possibly payments, tickets, certs,
// print jobs, check-ins — all of which require a registration). This runs BEFORE
// identity validation and hard-blocks non-minor identity changes on live events.

import { getRegistrationCounter } from '@/lib/firebase/firestore/registrationCounters'

export interface EventActivity {
  hasActivity:   boolean
  registrations: number
  checkedIn:     number
}

export async function getEventActivity(slug: string): Promise<EventActivity> {
  if (!slug) return { hasActivity: false, registrations: 0, checkedIn: 0 }
  const c = await getRegistrationCounter(slug)
  const registrations = c?.totalCount     ?? 0
  const checkedIn     = c?.checkedInCount ?? 0
  return { hasActivity: registrations > 0 || checkedIn > 0, registrations, checkedIn }
}
