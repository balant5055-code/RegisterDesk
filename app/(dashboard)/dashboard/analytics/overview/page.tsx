'use client'

// RD-ANALYTICS-06 · the new Analytics Overview, mounted alongside the existing pages.
//
// ═══ WHY HERE AND NOT IN PLACE OF SOMETHING ══════════════════════════════════
// `/dashboard/analytics` (the older per-event "Event Insights") and `/dashboard/reports`
// (the current analytics dashboard) both keep working untouched. This route proves the
// normalized contract end to end without asking anyone to accept a replacement first —
// which is what makes the eventual route migration a deletion rather than a gamble.
//
// It sits UNDER the canonical analytics path on purpose: `lib/analytics/routes.ts` names
// `/dashboard/analytics` as the canonical destination, so this is already inside the
// address the workspace is migrating toward.
//
// The dashboard layout already mounts EventContextProvider, so the selector, the URL
// synchronisation and the persisted selection all work here with no extra wiring.

import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import { AnalyticsScopeProvider } from '@/components/analytics/AnalyticsScopeProvider'
import { AnalyticsOverview } from '@/components/analytics/overview/AnalyticsOverview'

// RD-ANALYTICS-12-13 · the module strip, so this route is reachable from its siblings.
// Rendered here rather than inside the module component, which stays exactly as audited.
export default function AnalyticsOverviewPage() {
  return (
    // RD-ANALYTICS-12-33 · one payload for the strip and the module.
    <AnalyticsScopeProvider>
      <div className="space-y-4">
        <AnalyticsModuleNav />
        <AnalyticsOverview />
      </div>
    </AnalyticsScopeProvider>
  )
}
