// Homepage Journey — the connected operating flow (L2). Server Component.
//
// Tells the whole RegisterDesk workflow as ONE continuous flow (create → register
// → payments → participants → check-in → certificates → settlements), reusing the
// real journey registry (no invented steps). Matches the hero's language: pure
// white, pill eyebrow, hairline connectors, white icon-nodes, soft shadows.

import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { JourneyHeader } from '@/components/marketing/journey/JourneyHeader'
import { JourneyTimeline } from '@/components/marketing/journey/JourneyTimeline'
import { JOURNEY_STEPS } from '@/content/marketing/journey'
import type { JourneyStepDef } from '@/lib/marketing/types'

// The seven-step story, curated from the real lifecycle registry (order matters).
const FLOW_IDS = ['create', 'register', 'payments', 'participants', 'checkin', 'certificates', 'settlement'] as const

// Short one-line titles + two-line descriptions (registry copy trimmed for fit).
const FLOW_TITLE: Record<string, string> = {
  create:       'Create Event',
  register:     'Registrations',
  payments:     'Payments',
  participants: 'Participants',
  checkin:      'Check-in',
  certificates: 'Certificates',
  settlement:   'Settlement',
}
const FLOW_DESCRIPTION: Record<string, string> = {
  create:       'Set up details, passes, and forms.',
  register:     'Coupons, waitlists, and capacity.',
  payments:     'Secure checkout with auto refunds.',
  participants: 'One view of every attendee.',
  checkin:      'Fast QR check-in, even offline.',
  certificates: 'Design, issue, and verify.',
  settlement:   'Get paid to your bank or UPI.',
}

const FLOW_STEPS: JourneyStepDef[] = FLOW_IDS
  .map(id => JOURNEY_STEPS.find(s => s.id === id))
  .filter((s): s is JourneyStepDef => Boolean(s))
  .map(s => ({ ...s, title: FLOW_TITLE[s.id] ?? s.title, description: FLOW_DESCRIPTION[s.id] ?? s.description }))

export function Journey() {
  return (
    <SectionLayout background="white" labelledBy="journey-heading">
      <JourneyHeader />
      <JourneyTimeline steps={FLOW_STEPS} />
    </SectionLayout>
  )
}
