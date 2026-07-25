// RD-PLATFORM-COMMS-01 Phase 4H — the PURE Communication Insight rules engine (isomorphic).
//
// The ONE place insights are generated. Input: resolved Analytics + Health + Registry +
// Template health. Output: insights. PURE + deterministic (the caller supplies `now`), so it
// is fully testable. Every rule fires ONLY on a real condition — no fabricated insights; rules
// whose condition is absent (e.g. no draft templates) simply produce nothing.

import type { CommunicationAnalytics } from '@/lib/communications/analytics/types'
import type { CommunicationHealth } from '@/lib/communications/health/types'
import type { CommunicationInsight, InsightSeverity } from './types'

const FAILURE_RATE_THRESHOLD = 0.2     // 20%
const MIN_VOLUME_FOR_RATE    = 10
const HIGH_LATENCY_MS        = 5000

/** Minimal per-notification/template shapes the rules need (from Registry + Template Center). */
export interface InsightRegistryEntry { id: string; displayName: string; audience: string; mandatory: boolean; supports: { whatsapp: boolean } }
export interface InsightTemplate { templateId: string; notificationId: string; status: string; unknownVariables: string[]; bound: boolean }

export interface InsightInput {
  analytics: CommunicationAnalytics
  health:    CommunicationHealth
  registry:  InsightRegistryEntry[]
  templates: InsightTemplate[]
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 }

/** Generate the canonical read-only insight set. PURE. */
export function generateInsights(input: InsightInput, now: string): CommunicationInsight[] {
  const { analytics, health, registry, templates } = input
  const out: CommunicationInsight[] = []

  const base = (over: Partial<CommunicationInsight> & Pick<CommunicationInsight, 'insightId' | 'category' | 'severity' | 'title' | 'description' | 'recommendation'>): CommunicationInsight => ({
    status: 'open', relatedNotification: null, relatedTemplate: null, relatedProvider: null, relatedChannel: null,
    generatedAt: now, metadata: {}, futureRule: false, futureAutomation: false, futureWorkflow: false, ...over,
  })

  // ── Providers / configuration (from Health) ────────────────────────────────
  for (const ch of health.channels) {
    if (ch.state === 'available') {
      out.push(base({ insightId: `provider.not_configured.${ch.channel}`, category: 'providers', severity: 'high',
        title: `${label(ch.channel)} provider not configured`, description: ch.summary,
        recommendation: `Connect the ${label(ch.channel)} provider in Business Configuration.`, relatedChannel: ch.channel }))
    } else if (ch.state === 'down') {
      out.push(base({ insightId: `provider.down.${ch.channel}`, category: 'providers', severity: 'critical',
        title: `${label(ch.channel)} will not send`, description: ch.summary,
        recommendation: `Re-enable or reconnect ${label(ch.channel)}.`, relatedChannel: ch.channel }))
    } else if (ch.state === 'degraded') {
      out.push(base({ insightId: `provider.degraded.${ch.channel}`, category: 'providers', severity: 'medium',
        title: `${label(ch.channel)} is degraded`, description: ch.summary,
        recommendation: 'Resolve the caveat (e.g. top up the communication wallet).', relatedChannel: ch.channel }))
    } else if (!ch.implemented) {
      out.push(base({ insightId: `provider.unavailable.${ch.channel}`, category: 'providers', severity: 'informational', status: 'future',
        title: `${label(ch.channel)} is not available yet`, description: `${label(ch.channel)} has no transport implemented.`,
        recommendation: 'No action — reserved for a future channel.', relatedChannel: ch.channel, futureRule: true }))
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (health.overall === 'red') {
    out.push(base({ insightId: 'health.degraded', category: 'health', severity: 'critical',
      title: 'Communication health is critical', description: 'One or more channels will not send.',
      recommendation: 'Review the Health tab and address the red dimensions.' }))
  } else if (health.overall === 'amber') {
    out.push(base({ insightId: 'health.degraded', category: 'health', severity: 'medium',
      title: 'Communication health is degraded', description: 'One or more channels have caveats.',
      recommendation: 'Review the Health tab recommendations.' }))
  }

  // ── Delivery / performance (from Analytics — which reads the Timeline) ──────
  if (analytics.scanned === 0) {
    out.push(base({ insightId: 'analytics.no_activity', category: 'delivery', severity: 'informational',
      title: 'No communication activity in the analyzed window', description: 'The timeline window contains no communications.',
      recommendation: 'No action — insights populate as communications are sent.' }))
  } else {
    if (analytics.overall.failureRate > FAILURE_RATE_THRESHOLD && analytics.overall.volume >= MIN_VOLUME_FOR_RATE) {
      out.push(base({ insightId: 'delivery.high_failure_overall', category: 'delivery', severity: 'high',
        title: `High overall failure rate (${(analytics.overall.failureRate * 100).toFixed(1)}%)`,
        description: `${analytics.overall.failed} of ${analytics.overall.volume} communications failed in the window.`,
        recommendation: 'Investigate the top failing providers/notifications.', metadata: { failed: analytics.overall.failed, volume: analytics.overall.volume } }))
    }
    for (const p of analytics.byProvider) {
      const fr = p.metrics.volume > 0 ? p.metrics.failed / p.metrics.volume : 0
      if (fr > FAILURE_RATE_THRESHOLD && p.metrics.volume >= MIN_VOLUME_FOR_RATE) {
        out.push(base({ insightId: `performance.high_failure.${p.provider}`, category: 'performance', severity: 'high',
          title: `High failure rate: ${p.provider} (${(fr * 100).toFixed(1)}%)`, description: `${p.metrics.failed} of ${p.metrics.volume} failed.`,
          recommendation: 'Check the provider error distribution and configuration.', relatedProvider: p.provider,
          metadata: { topError: p.errorDistribution[0]?.code } }))
      }
      if (p.metrics.avgLatencyMs != null && p.metrics.avgLatencyMs > HIGH_LATENCY_MS) {
        out.push(base({ insightId: `performance.high_latency.${p.provider}`, category: 'performance', severity: 'medium',
          title: `High latency: ${p.provider} (${p.metrics.avgLatencyMs} ms avg)`, description: 'Average send-to-complete latency is elevated.',
          recommendation: 'Check provider status and network conditions.', relatedProvider: p.provider }))
      }
    }
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  const tmplVol = new Map(analytics.byTemplate.map(t => [t.templateId, t.metrics.volume]))
  for (const t of templates) {
    if (t.unknownVariables.length > 0) {
      out.push(base({ insightId: `templates.unknown_vars.${t.templateId}`, category: 'templates', severity: 'high',
        title: `Template uses unknown variables: ${t.templateId}`, description: `Unknown: ${t.unknownVariables.join(', ')}`,
        recommendation: 'Fix the template to use only registered variables.', relatedTemplate: t.templateId, relatedNotification: t.notificationId }))
    }
    if (t.status === 'draft') {
      out.push(base({ insightId: `templates.draft_active.${t.templateId}`, category: 'templates', severity: 'medium',
        title: `Draft template still bound: ${t.templateId}`, description: 'A draft template is bound to a live notification.',
        recommendation: 'Publish or replace the draft template.', relatedTemplate: t.templateId, relatedNotification: t.notificationId }))
    }
    if (!t.bound) {
      out.push(base({ insightId: `templates.missing_binding.${t.templateId}`, category: 'templates', severity: 'high',
        title: `Template missing notification binding: ${t.templateId}`, description: 'Template is not bound to a notification.',
        recommendation: 'Bind the template to a notification.', relatedTemplate: t.templateId }))
    }
  }
  const unusedTemplates = templates.filter(t => (tmplVol.get(t.templateId) ?? 0) === 0).map(t => t.templateId)
  if (unusedTemplates.length > 0) {
    out.push(base({ insightId: 'templates.unused', category: 'templates', severity: 'informational',
      title: `${unusedTemplates.length} template(s) unused in the window`, description: 'These templates recorded no sends in the analyzed window.',
      recommendation: 'No action if expected; review if a notification should have fired.', metadata: { count: unusedTemplates.length, templates: unusedTemplates.slice(0, 20).join(', ') } }))
  }

  // ── Notifications (coverage + recommendation) ──────────────────────────────
  const notifVol = new Map(analytics.byNotification.map(n => [n.notificationId, n.metrics.volume]))
  const neverSent = registry.filter(e => (notifVol.get(e.id) ?? 0) === 0).map(e => e.displayName)
  if (neverSent.length > 0) {
    out.push(base({ insightId: 'notifications.never_sent', category: 'notifications', severity: 'informational',
      title: `${neverSent.length} notification(s) with no activity in the window`, description: 'These notifications recorded no sends in the analyzed window.',
      recommendation: 'No action if expected.', metadata: { count: neverSent.length, notifications: neverSent.slice(0, 20).join(', ') } }))
  }
  const missingWa = registry.filter(e => e.audience === 'organizer' && e.mandatory && !e.supports.whatsapp).map(e => e.displayName)
  if (missingWa.length > 0) {
    out.push(base({ insightId: 'recommendation.missing_whatsapp', category: 'recommendation', severity: 'informational', status: 'future',
      title: `${missingWa.length} mandatory organizer notification(s) have no WhatsApp template`, description: 'Adding WhatsApp templates could improve reach for critical notifications.',
      recommendation: 'Consider adding approved WhatsApp templates for these notifications.', metadata: { count: missingWa.length, notifications: missingWa.slice(0, 20).join(', ') }, futureRule: true }))
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

function label(ch: string): string {
  return ch === 'whatsapp' ? 'WhatsApp' : ch === 'sms' ? 'SMS' : ch === 'push' ? 'Push' : ch === 'inapp' ? 'In-app' : 'Email'
}
