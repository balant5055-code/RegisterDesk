'use client'

// RD-ANALYTICS-12-33 · the one place a module page fetches its payload.
//
// The module strip (which hides modules the event cannot support) and the module body both
// read the analytics payload. Rendering them as siblings under this provider means ONE
// fetch per page, one range state, one loading machine — the strip cannot disagree with the
// body about which event or window it is showing. Page-local React state; nothing here
// outlives the page or is shared across requests.

import type { ReactNode } from 'react'
import { AnalyticsScopeContext, useStandaloneAnalyticsScope, type AnalyticsPreset } from './useAnalyticsScope'

export function AnalyticsScopeProvider({ children, initialPreset = '30d' }: {
  children: ReactNode
  initialPreset?: AnalyticsPreset
}) {
  const scope = useStandaloneAnalyticsScope(initialPreset, true)
  return <AnalyticsScopeContext.Provider value={scope}>{children}</AnalyticsScopeContext.Provider>
}
