'use client'

// RD-ANALYTICS-12-29 · the Participants module of the Analytics workspace.
//
// Mounted beside its five siblings under the path `lib/analytics/routes.ts` names as
// canonical. The module's content is registration composition — seats by source and by
// status — and nothing that identifies a person; the module component and the audit that
// bounded it (docs/RD-ANALYTICS-12-29-PARTICIPANT-INTELLIGENCE-AUDIT.md) say why.
//
// Availability is decided on the SERVER: the payload's `participants` block is present only
// when the producer measured the composition, and `capabilities.modules` lists this module
// only then. This route is not a permission boundary and must not become one.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { ParticipantsAnalytics } from '@/components/analytics/participants/ParticipantsAnalytics'

export default function AnalyticsParticipantsPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <ParticipantsAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
