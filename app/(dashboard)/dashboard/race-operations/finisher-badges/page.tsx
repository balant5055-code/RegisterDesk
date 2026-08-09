// RD-BADGE-01 · Race Operations → Finisher Badges.
//
// Organizer-only, behind the existing Race Operations access gate (owner or admin).

import { PageHeader } from '@/components/ui'
import { RaceOpsAccessGate } from '@/features/race-operations'
import { BadgeStatusClient } from '@/features/finisher-badges/components/BadgeStatusClient'
import { ROUTES } from '@/config/navigation'

export const metadata = { title: 'Finisher Badges — RegisterDesk' }

export default function FinisherBadgesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Finisher Badges"
        subtitle="Shareable 1080×1080 badges, generated from published results."
        breadcrumb={[
          { label: 'Race Operations', href: ROUTES.RACE_OPS },
          { label: 'Finisher Badges' },
        ]}
      />
      <RaceOpsAccessGate>
        <BadgeStatusClient />
      </RaceOpsAccessGate>
    </div>
  )
}
