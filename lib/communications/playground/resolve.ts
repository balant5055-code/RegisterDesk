// RD-PLATFORM-COMMS-01 Phase 4I — the canonical Communication Playground resolver (server).
//
// Composes the EXISTING canonical resolvers (Registry, Policy, Templates, Variables, Health,
// Analytics aggregator, Insight engine) into a single read-only QA session for one chosen
// notification + channel. It PROJECTS the pipeline — it persists nothing, sends nothing, and
// bypasses no canonical resolver. Every field is derived; none is fabricated.

import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { resolveNotificationPolicy } from '@/lib/communications/policy/resolve'
import { buildTemplatesForNotification } from '@/lib/communications/templates/registry'
import { getVariable, isKnownVariable } from '@/lib/communications/templates/variables'
import { resolveCommunicationHealth } from '@/lib/communications/health/resolve'
import { aggregateAnalytics } from '@/lib/communications/analytics/aggregate'
import { generateInsights } from '@/lib/communications/insights/generate'
import type { TimelineEntry, TimelineStatus } from '@/lib/communications/timeline/types'
import type { PlaygroundInput, PlaygroundSession, PlaygroundValidation } from './types'
import { reachableStages, providerFor } from './project'

/** Resolve a read-only Playground session by composing the canonical resolvers. */
export async function resolvePlaygroundSession(
  input: PlaygroundInput,
  now:   string = new Date().toISOString(),
): Promise<PlaygroundSession> {
  const { notificationId, channel } = input
  const [registry, health] = await Promise.all([resolveCommunicationRegistry(), resolveCommunicationHealth({})])
  const entry = registry.find(e => e.id === notificationId)

  if (!entry) {
    return {
      notificationId, channel, found: false, registry: null,
      supports: { email: false, whatsapp: false, inapp: false, sms: false, push: false },
      policy: null, template: null,
      validation: [{ check: 'registry', ok: false, detail: `No registry entry for "${notificationId}".` }],
      timelineProjection: [], analyticsProjection: blankMetrics(), insightProjection: [],
    }
  }

  const supports = { ...entry.supports }
  const policy   = resolveNotificationPolicy(entry, entry.supports)
  const templates = buildTemplatesForNotification(entry, { email: entry.supports.email, whatsapp: entry.supports.whatsapp, inapp: entry.supports.inapp })
  const template  = templates.find(t => t.channel === channel) ?? null

  const variables = (template?.variables ?? []).map(id => {
    const v = getVariable(id)
    return { id, token: `{{${id}}}`, label: v?.label ?? id, sample: v?.example ?? '', known: isKnownVariable(id) }
  })

  const channelSupported = channel === 'email' ? supports.email : channel === 'whatsapp' ? supports.whatsapp : channel === 'inapp' ? supports.inapp : false
  const configured = channel === 'inapp'
    ? true
    : health.channels.find(c => c.channel === channel)?.state !== 'available' && health.channels.find(c => c.channel === channel)?.implemented === true

  const validation: PlaygroundValidation[] = [
    { check: 'registry',  ok: true,  detail: `Bound to ${entry.displayName}.` },
    { check: 'policy',    ok: true,  detail: `Priority ${policy.priority}, ${policy.deliveryMode} delivery.` },
    { check: 'template',  ok: !!template, detail: template ? `Template ${template.templateId} (v${template.version}, ${template.status}).` : `No ${channel} template for this notification.` },
    { check: 'binding',   ok: !!template?.notificationId, detail: template?.notificationId ? `Bound to ${template.notificationId}.` : 'Template not bound.' },
    { check: 'channel',   ok: channelSupported, detail: channelSupported ? `${channel} is supported.` : `${channel} is not supported for this notification.` },
    { check: 'variables', ok: variables.every(v => v.known), detail: variables.every(v => v.known) ? `All ${variables.length} variables are registered.` : `Unknown: ${variables.filter(v => !v.known).map(v => v.id).join(', ')}` },
    { check: 'provider',  ok: !!configured, detail: configured ? `${providerFor(channel)} provider is configured.` : `${providerFor(channel)} provider is not configured (QA note).` },
  ]

  // Projected timeline entry (optimistic success) → projected analytics via the canonical aggregator.
  const projectedStatus: TimelineStatus = (channel === 'whatsapp' || channel === 'inapp') ? 'delivered' : 'sent'
  const projected: TimelineEntry = {
    timelineId: 'playground', notificationId, templateId: template?.templateId ?? `${notificationId}.${channel}`, templateVersion: template?.version ?? 1,
    policyId: notificationId, recipient: 'sample@registerdesk.app', recipientType: 'organizer',
    channel: channel as TimelineEntry['channel'], provider: providerFor(channel), trigger: entry.trigger, status: projectedStatus,
    queuedAt: now, sentAt: now, retryCount: 0, latencyMs: null, providerReference: null, errorCode: null, errorMessage: null, metadata: {},
  }
  const analytics = aggregateAnalytics([projected], { [notificationId]: { displayName: entry.displayName, category: entry.category } })

  const insightProjection = generateInsights({
    analytics,
    health,
    registry:  [{ id: entry.id, displayName: entry.displayName, audience: entry.audience, mandatory: entry.mandatory, supports: { whatsapp: entry.supports.whatsapp } }],
    templates: template ? [{ templateId: template.templateId, notificationId: template.notificationId, status: template.status, unknownVariables: variables.filter(v => !v.known).map(v => v.id), bound: !!template.notificationId }] : [],
  }, now)

  return {
    notificationId, channel, found: true,
    registry: { category: entry.category, displayName: entry.displayName, description: entry.description, trigger: entry.trigger, audience: entry.audience },
    supports, policy,
    template: template ? { templateId: template.templateId, status: template.status, version: template.version, variables } : null,
    validation,
    timelineProjection:  reachableStages(channel),
    analyticsProjection: analytics.overall,
    insightProjection,
  }
}

function blankMetrics() {
  return { volume: 0, accepted: 0, delivered: 0, opened: 0, clicked: 0, failed: 0, cancelled: 0, retrying: 0, queued: 0, avgLatencyMs: null, lastAt: null }
}
