'use client'

// RD-ANALYTICS-09 · the Revenue module of the Analytics workspace.
//
// Mounted beside `/dashboard/analytics/overview` and `/registrations`, under the path
// `lib/analytics/routes.ts` names as canonical. Nothing is replaced: the older
// `/dashboard/analytics` Event Insights page, `/dashboard/reports` and
// `/dashboard/finance/reports` all keep working untouched.
//
// Financial access is decided on the SERVER: a caller without `transactions` receives a
// payload with no `revenue` key at all, and the module says so rather than rendering an
// empty shell. This route is not a second authorization boundary and must never become one.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { RevenueAnalytics } from '@/components/analytics/revenue/RevenueAnalytics'

// RD-ANALYTICS-12-13 · the module strip, so this route is reachable from its siblings.
// Rendered here rather than inside the module component, which stays exactly as audited.
export default function AnalyticsRevenuePage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <RevenueAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
