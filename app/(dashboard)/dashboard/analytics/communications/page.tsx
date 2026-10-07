'use client'

// RD-ANALYTICS-11 · the Communications module of the Analytics workspace.
//
// Mounted beside Overview, Registrations, Revenue and Operations, under the path
// `lib/analytics/routes.ts` names as canonical. Nothing is replaced.
//
// Messaging spend is decided on the SERVER: a caller without `transactions` receives a
// payload with no `spend` key, and the cost aggregate is never issued for them. This route
// is not a financial boundary and must not become one.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { CommunicationsAnalytics } from '@/components/analytics/communications/CommunicationsAnalytics'

// RD-ANALYTICS-12-13 · the module strip, so this route is reachable from its siblings.
// Rendered here rather than inside the module component, which stays exactly as audited.
export default function AnalyticsCommunicationsPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <CommunicationsAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
