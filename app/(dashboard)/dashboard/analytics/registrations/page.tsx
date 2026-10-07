'use client'

// RD-ANALYTICS-08 · the Registrations module of the Analytics workspace.
//
// Mounted beside `/dashboard/analytics/overview`, under the path `lib/analytics/routes.ts`
// names as canonical, so the workspace grows inside the address it is migrating toward.
// Nothing is replaced: the older `/dashboard/analytics` Event Insights page and
// `/dashboard/reports` both keep working untouched, exactly as RD-ANALYTICS-06 left them.
//
// The dashboard layout already mounts EventContextProvider, so the event selector, the URL
// synchronisation and the persisted selection all work here with no extra wiring.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { RegistrationsAnalytics } from '@/components/analytics/registrations/RegistrationsAnalytics'

// RD-ANALYTICS-12-13 · the module strip, so this route is reachable from its siblings.
// Rendered here rather than inside the module component, which stays exactly as audited.
export default function AnalyticsRegistrationsPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <RegistrationsAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
