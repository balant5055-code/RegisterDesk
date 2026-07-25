// RD-PLATFORM-COMMS-01 Phase 4G — the canonical Communication Analytics resolver (server).
//
// Analytics CONSUMES THE TIMELINE — it calls resolveTimeline() and aggregates the resolved
// entries. It never reads emailLogs or providers directly, so the Timeline stays the single
// operational source of truth. Registry metadata (displayName/category) is joined in for the
// per-notification/per-category breakdowns. READ-ONLY.

import { resolveTimeline } from '@/lib/communications/timeline/resolve'
import type { TimelineFilters } from '@/lib/communications/timeline/types'
import { COMMUNICATION_REGISTRY } from '@/lib/communications/registry/catalog'
import { aggregateAnalytics, type NotificationMeta } from './aggregate'
import type { CommunicationAnalytics } from './types'

const NOTIFICATION_META: Record<string, NotificationMeta> = Object.fromEntries(
  COMMUNICATION_REGISTRY.map(e => [e.id, { displayName: e.displayName, category: e.category }]),
)

/** Resolve communication analytics by aggregating resolved timeline entries. */
export async function resolveCommunicationAnalytics(filters: TimelineFilters = {}): Promise<CommunicationAnalytics> {
  // Analytics reads a bounded window of the timeline (the operational source of truth).
  const { entries } = await resolveTimeline({ ...filters, limit: filters.limit ?? 500 })
  return aggregateAnalytics(entries, NOTIFICATION_META)
}
