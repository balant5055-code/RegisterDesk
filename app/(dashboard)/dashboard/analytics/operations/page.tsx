'use client'

// RD-ANALYTICS-10 · the Operations module of the Analytics workspace.
//
// Mounted beside Overview, Registrations and Revenue, under the path
// `lib/analytics/routes.ts` names as canonical. Nothing is replaced.
//
// Which panels exist is decided on the SERVER, from the event's own `identifierConfigs`
// document — never from its event type, and never in this file. This route is not a
// capability boundary and must not become one.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { OperationsAnalytics } from '@/components/analytics/operations/OperationsAnalytics'

// RD-ANALYTICS-12-13 · the module strip, so this route is reachable from its siblings.
// Rendered here rather than inside the module component, which stays exactly as audited.
export default function AnalyticsOperationsPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <OperationsAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
