'use client'

// RD-ANALYTICS-12-31 · the Insights module of the Analytics workspace.
//
// Mounted beside its siblings under the path `lib/analytics/routes.ts` names as canonical.
// The module computes NOTHING of its own: it runs `buildInsights` — a pure function — over
// the same `AnalyticsResponse` every other module renders, so a card can only ever cite a
// figure the reader could already see, under the permission that already produced it.
//
// This route is not a permission boundary and must not become one.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { InsightsAnalytics } from '@/components/analytics/insights/InsightsAnalytics'

export default function AnalyticsInsightsPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <InsightsAnalytics />
      </div>
    </AnalyticsScopeProvider>
  )
}
