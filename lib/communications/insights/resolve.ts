// RD-PLATFORM-COMMS-01 Phase 4H — the canonical Communication Insight resolver (server).
//
// Gathers the resolved Analytics + Health + Registry + Template Center, then runs the ONE pure
// rules engine (./generate). Analytics is the only analytics source; the Timeline (which
// Analytics consumes) remains the only operational source. READ-ONLY — nothing is mutated,
// acknowledged, or remediated.

import { resolveCommunicationAnalytics } from '@/lib/communications/analytics/resolve'
import { resolveCommunicationHealth } from '@/lib/communications/health/resolve'
import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { resolveTemplateCenter } from '@/lib/communications/templates/server'
import { generateInsights, type InsightInput } from './generate'
import type { CommunicationInsight, InsightFilters } from './types'

export async function resolveCommunicationInsights(
  filters: InsightFilters = {},
  now:     string = new Date().toISOString(),
): Promise<CommunicationInsight[]> {
  const [analytics, health, registry, templateCenter] = await Promise.all([
    resolveCommunicationAnalytics(),
    resolveCommunicationHealth({}),
    resolveCommunicationRegistry(),
    resolveTemplateCenter(),
  ])

  const input: InsightInput = {
    analytics,
    health,
    registry:  registry.map(e => ({ id: e.id, displayName: e.displayName, audience: e.audience, mandatory: e.mandatory, supports: { whatsapp: e.supports.whatsapp } })),
    templates: templateCenter.templates.map(t => ({ templateId: t.templateId, notificationId: t.notificationId, status: t.status, unknownVariables: t.health.unknownVariables, bound: t.health.bound })),
  }

  let insights = generateInsights(input, now)

  if (filters.severity)     insights = insights.filter(i => i.severity === filters.severity)
  if (filters.category)     insights = insights.filter(i => i.category === filters.category)
  if (filters.status)       insights = insights.filter(i => i.status === filters.status)
  if (filters.provider)     insights = insights.filter(i => i.relatedProvider === filters.provider)
  if (filters.notification) insights = insights.filter(i => i.relatedNotification === filters.notification)

  return insights
}
