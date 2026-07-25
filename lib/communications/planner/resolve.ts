// RD-PLATFORM-COMMS-02 Phase 5E — the canonical Campaign Execution Planner resolver (server).
//
// Produces a deterministic ExecutionPlan by COMPOSING the existing canonical resolvers
// (Campaign Registry, Approval, Audience, Communication Registry, Policy, Templates, Health,
// Communication Config). It duplicates NO planning logic — the math + validation live in the
// pure ./project module. READ-ONLY: it makes NO provider calls, sends nothing, schedules
// nothing, builds no queue, and persists nothing. Every number is a projection.

import { resolveCampaigns } from '@/lib/communications/campaigns/resolve'
import { resolveCampaignApproval } from '@/lib/communications/approval/resolve'
import { resolveAudiences } from '@/lib/communications/audiences/resolve'
import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { resolveNotificationPolicy } from '@/lib/communications/policy/resolve'
import { buildTemplatesForNotification } from '@/lib/communications/templates/registry'
import { isKnownVariable } from '@/lib/communications/templates/variables'
import { resolveCommunicationHealth } from '@/lib/communications/health/resolve'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { CHANNEL_CAPABILITIES } from '@/lib/communications/health/channels'
import { projectChannels, projectBatches, projectCost, buildPlanValidation } from './project'
import { PLAN_BATCH_SIZE } from './types'
import type { ExecutionPlan, ProviderReadiness } from './types'

function providerFor(ch: string): string { return ch === 'whatsapp' ? 'meta' : ch === 'inapp' ? 'inapp' : 'ses' }

/** Resolve a read-only execution plan for a campaign. */
export async function resolveExecutionPlan(campaignId: string, now: string = new Date().toISOString()): Promise<ExecutionPlan> {
  const [campaigns, approval, health, config, registry] = await Promise.all([
    resolveCampaigns({ limit: 500 }),
    resolveCampaignApproval(campaignId),
    resolveCommunicationHealth({}),
    getCommunicationConfig(),
    resolveCommunicationRegistry(),
  ])

  const campaign = campaigns.find(c => c.campaignId === campaignId) ?? null
  const entry    = campaign?.notificationId ? registry.find(e => e.id === campaign.notificationId) ?? null : null
  const audiences = campaign?.audienceId ? await resolveAudiences() : []
  const audienceRec = campaign?.audienceId ? audiences.find(a => a.audienceId === campaign.audienceId) ?? null : null

  const policy    = entry ? resolveNotificationPolicy(entry, entry.supports) : null
  const templates = entry ? buildTemplatesForNotification(entry, { email: entry.supports.email, whatsapp: entry.supports.whatsapp, inapp: entry.supports.inapp }) : []
  const channelProjections = projectChannels(entry ? entry.supports : { email: false, whatsapp: false, inapp: false })
  const usedChannels = channelProjections.filter(c => c.supported)

  // Recipients: only known once the audience has been evaluated (honest — no live evaluation here).
  const recipients = audienceRec?.lastEvaluatedAt ? audienceRec.estimatedSize : null
  const { messages, batches } = projectBatches(recipients, usedChannels.length)

  const pricing = usedChannels.map(c => {
    const cap = CHANNEL_CAPABILITIES[c.channel as keyof typeof CHANNEL_CAPABILITIES]
    const price = c.channel === 'whatsapp' ? config.whatsapp.pricePaise : c.channel === 'sms' ? config.sms.pricePaise : 0
    return { channel: c.channel, paid: !!cap?.paid, pricePaise: price }
  })
  const estimatedCostPaise = projectCost(recipients, pricing)

  const providerReadiness: ProviderReadiness[] = usedChannels.map(c => {
    const h = health.channels.find(hc => hc.channel === c.channel)
    const ready = c.channel === 'inapp' ? true : (h?.state === 'configured' || h?.state === 'ready')
    return { provider: providerFor(c.channel), channel: c.channel, ready, state: h?.state ?? 'unknown', detail: h?.summary ?? '' }
  })

  const unknownVariables = (templates.find(t => usedChannels.some(c => c.channel === t.channel))?.variables ?? []).filter(id => !isKnownVariable(id))
  const approved = approval.currentState === 'approved' || approval.currentState === 'scheduled'

  const validation = buildPlanValidation({
    campaignFound: !!campaign,
    approved,
    audience: audienceRec ? { valid: audienceRec.valid, evaluated: !!audienceRec.lastEvaluatedAt } : null,
    hasTemplate: templates.length > 0,
    unknownVariables,
    policyResolved: !!policy,
    usedProvidersReady: providerReadiness.length > 0 && providerReadiness.every(p => p.ready),
    walletSufficient: null,   // no single platform wallet applies — see notes
  })

  return {
    planId: `plan:${campaignId}`,
    campaignId,
    campaignName: campaign?.name ?? null,
    approvalState: approval.currentState,
    audience: audienceRec ? {
      audienceId: audienceRec.audienceId, name: audienceRec.name, scope: audienceRec.scopeLabel,
      ruleCount: audienceRec.ruleCount, estimatedReach: recipients, health: audienceRec.health, valid: audienceRec.valid,
    } : null,
    estimatedRecipients: recipients,
    estimatedChannels: channelProjections,
    estimatedMessages: messages,
    estimatedBatches: batches,
    batchSize: PLAN_BATCH_SIZE,
    estimatedCostPaise,
    providerReadiness,
    walletReadiness: {
      balancePaise: null,
      estimatedCostPaise: estimatedCostPaise ?? 0,
      sufficient: null,
      notes: 'Platform → organizer email is free; WhatsApp to organizers is free (freeOrganizerNotifications). This is a worst-case per-message projection — no single platform wallet applies.',
    },
    validation,
    generatedAt: now,
    metadata: { healthOverall: health.overall },
  }
}
