// RD-PLATFORM-COMMS-02 Phase 5C — the canonical Campaign Composer resolver (server).
//
// Assembles a CampaignDraft by COMPOSING the EXISTING canonical resolvers (Communication
// Registry, Policy, Templates, Variables, Audience Builder, Health). It duplicates NO domain
// logic and consumes only canonical resolvers. READ-ONLY — it persists nothing, executes
// nothing, schedules nothing, sends nothing. The draft is an ephemeral, deterministic projection.

import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { resolveNotificationPolicy } from '@/lib/communications/policy/resolve'
import { buildTemplatesForNotification } from '@/lib/communications/templates/registry'
import { getVariable, isKnownVariable } from '@/lib/communications/templates/variables'
import { resolveAudiences } from '@/lib/communications/audiences/resolve'
import { resolveCommunicationHealth } from '@/lib/communications/health/resolve'
import { buildComposerValidation } from './validate'
import type { CampaignDraft, ComposerInput, ComposerVariable } from './types'

/** Resolve a read-only CampaignDraft by composing the canonical resolvers. */
export async function resolveCampaignDraft(
  input:     ComposerInput,
  createdBy: string,
  now:       string = new Date().toISOString(),
): Promise<CampaignDraft> {
  const { notificationId, channel, audienceId } = input

  const [registry, health, audiences] = await Promise.all([
    resolveCommunicationRegistry(),
    resolveCommunicationHealth({}),
    input.audienceId ? resolveAudiences() : Promise.resolve([]),
  ])

  const entry    = registry.find(e => e.id === notificationId)
  const policy   = entry ? resolveNotificationPolicy(entry, entry.supports) : null
  const templates = entry ? buildTemplatesForNotification(entry, { email: entry.supports.email, whatsapp: entry.supports.whatsapp, inapp: entry.supports.inapp }) : []
  const template  = templates.find(t => t.channel === channel) ?? null

  const variables: ComposerVariable[] = (template?.variables ?? []).map(id => {
    const v = getVariable(id)
    return { id, token: `{{${id}}}`, label: v?.label ?? id, sample: v?.example ?? '', known: isKnownVariable(id) }
  })

  const audienceRec = audienceId ? audiences.find(a => a.audienceId === audienceId) ?? null : null
  const supportedChannels = entry
    ? (['email', 'whatsapp', 'inapp'] as const).filter(c => c === 'email' ? entry.supports.email : c === 'whatsapp' ? entry.supports.whatsapp : entry.supports.inapp)
    : []
  const channelSupported = supportedChannels.includes(channel as (typeof supportedChannels)[number])

  const campaign = {
    name:     input.name?.trim() || (entry ? `${entry.displayName} campaign` : 'Untitled campaign'),
    type:     input.type ?? 'announcement' as const,
    category: input.category ?? 'platform' as const,
  }

  const validation = buildComposerValidation({
    campaignName:     campaign.name,
    campaignType:     campaign.type,
    campaignCategory: campaign.category,
    notificationFound: !!entry,
    audience:         audienceRec ? { valid: audienceRec.valid, health: audienceRec.health } : null,
    template:         template ? { bound: !!template.notificationId } : null,
    channelSupported,
    variables,
    policyResolved:   !!policy,
  })

  return {
    draftId:  `draft:${notificationId}:${channel}:${audienceId ?? 'none'}`,   // deterministic, ephemeral
    campaign,
    channel,
    audience: audienceRec ? {
      audienceId: audienceRec.audienceId, name: audienceRec.name, type: audienceRec.typeLabel, scope: audienceRec.scopeLabel,
      ruleCount: audienceRec.ruleCount, estimatedReach: audienceRec.lastEvaluatedAt ? audienceRec.estimatedSize : null,
      health: audienceRec.health, valid: audienceRec.valid,
    } : null,
    notification: entry ? {
      id: entry.id, displayName: entry.displayName, category: entry.category, priority: entry.priority,
      supportedChannels, templateAvailable: !!template,
    } : null,
    template: template ? { templateId: template.templateId, channel: template.channel, status: template.status, version: template.version } : null,
    policy,
    variables,
    validation,
    createdBy,
    createdAt: now,
    metadata: { healthOverall: health.overall },
  }
}
