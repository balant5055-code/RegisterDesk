// RD-PLATFORM-COMMS-01 Phase 4B — the ADMIN communication overview read model (server-only).
//
// THE single source the Admin Communication Center reads for Overview + Providers + Health.
// It composes ONLY canonical resolvers — resolveCommunicationContext (Phase 2 health/channels),
// the CHANNEL_CAPABILITIES SSOT, isChannelConfigured (provider resolver), and the existing
// getAdminCommunications aggregation — and DERIVES the provider views + health recommendations
// from that real state. READ-ONLY: sends nothing, charges nothing, mutates nothing, and
// changes no send/provider/wallet/billing/template/notification behavior. Never fabricates
// status or recommendations — every value traces to a real signal.

import { resolveCommunicationContext } from './resolve'
import { CHANNEL_CAPABILITIES } from './channels'
import { isChannelConfigured } from '@/lib/notifications/providerResolver'
import { NotificationChannel } from '@/lib/notifications/channels'
import { getAdminCommunications } from '@/lib/analytics/adminCommunications'
import { WHATSAPP_TEMPLATE_REGISTRY } from '@/lib/whatsapp'
import type {
  CommChannelId, ChannelState, HealthStatus, DimensionResult, CommunicationHealth,
} from './types'

export interface AdminProviderView {
  id:               CommChannelId
  label:            string
  implemented:      boolean
  configured:       boolean
  enabled:          boolean       // platform-enabled in Business Configuration
  paid:             boolean
  pricePaise:       number        // per-message (0 for free/unavailable)
  deliveryReceipts: boolean       // provider reports delivered/read status
  state:            ChannelState
  status:           HealthStatus
  summary:          string
  dimensions:       DimensionResult[]
}

export interface AdminRecommendation {
  severity: Exclude<HealthStatus, 'green'>   // amber | red — greens are not recommendations
  channel:  CommChannelId | 'platform'
  title:    string
  action:   string
}

export interface AdminCommunicationOverview {
  overall:         HealthStatus
  providers:       AdminProviderView[]
  health:          CommunicationHealth
  recommendations: AdminRecommendation[]
  counts: {
    accepted:           number   // provider-accepted (SES 'sent')
    delivered:          number   // provider-confirmed delivered (WhatsApp/Meta only — honest)
    failed:             number
    pending:            number   // queued
    skipped:            number
    whatsapp:           number
    campaigns:          number
    campaignsScheduled: number
    remindersScheduled: number
    whatsappTemplates:  number
  }
}

const CONFIGURABLE: Record<CommChannelId, NotificationChannel | null> = {
  email:    NotificationChannel.EMAIL,
  whatsapp: NotificationChannel.WHATSAPP,
  sms:      null,   // no transport — never configured
  push:     null,
}

/** Resolve the complete admin communication overview from canonical resolvers. */
export async function resolveAdminCommunicationOverview(): Promise<AdminCommunicationOverview> {
  // Platform-scope health + config (no organizer/event) via the canonical resolver.
  const ctx      = await resolveCommunicationContext({})
  const analytics = await getAdminCommunications()

  const cfg = ctx.config
  const cfgByChannel = cfg as unknown as Record<string, { enabled?: boolean; pricePaise?: number }>
  const enabledOf = (id: CommChannelId): boolean =>
    id === 'push' ? false : Boolean(cfgByChannel[id]?.enabled)
  const priceOf = (id: CommChannelId): number =>
    id === 'push' ? 0 : Number(cfgByChannel[id]?.pricePaise ?? 0)

  const providers: AdminProviderView[] = ctx.health.channels.map(ch => {
    const cap        = CHANNEL_CAPABILITIES[ch.channel]
    const chEnum     = CONFIGURABLE[ch.channel]
    const configured = chEnum ? isChannelConfigured(chEnum) : false
    return {
      id:               ch.channel,
      label:            cap.label,
      implemented:      cap.implemented,
      configured,
      enabled:          enabledOf(ch.channel),
      paid:             cap.paid,
      pricePaise:       priceOf(ch.channel),
      deliveryReceipts: cap.deliveryReceipts,
      state:            ch.state,
      status:           ch.status,
      summary:          ch.summary,
      dimensions:       ch.dimensions,
    }
  })

  return {
    overall:         ctx.health.overall,
    providers,
    health:          ctx.health,
    recommendations: deriveRecommendations(providers),
    counts: {
      accepted:           analytics.messages.sent,
      delivered:          analytics.messages.delivered,
      failed:             analytics.messages.failed,
      pending:            analytics.messages.queued,
      skipped:            analytics.messages.skipped,
      whatsapp:           analytics.messages.whatsapp,
      campaigns:          analytics.broadcasts.total,
      campaignsScheduled: analytics.broadcasts.scheduled,
      remindersScheduled: analytics.reminders.scheduled,
      whatsappTemplates:  Object.keys(WHATSAPP_TEMPLATE_REGISTRY).length,
    },
  }
}

/** Actionable, grounded recommendations. Each is derived from a REAL provider signal —
 *  configuration, enablement, transport availability, or delivery-tracking capability.
 *  Nothing here is fabricated. */
function deriveRecommendations(providers: AdminProviderView[]): AdminRecommendation[] {
  const out: AdminRecommendation[] = []
  for (const p of providers) {
    if (!p.implemented) {
      // SMS / Push — surfaced honestly as unavailable (informational), not as a fault.
      out.push({
        severity: 'amber',
        channel:  p.id,
        title:    `${p.label} is not available yet`,
        action:   `No ${p.label} transport is implemented — the channel cannot send.`,
      })
      continue
    }
    if (!p.configured) {
      out.push({ severity: 'red', channel: p.id, title: `${p.label} provider not connected`, action: `Add ${p.label} credentials in provider configuration.` })
      continue
    }
    if (!p.enabled) {
      out.push({ severity: 'red', channel: p.id, title: `${p.label} disabled in Business Configuration`, action: `Enable ${p.label} in Business Configuration → Communication.` })
    }
    if (!p.deliveryReceipts) {
      out.push({
        severity: 'amber',
        channel:  p.id,
        title:    `${p.label} delivery tracking not connected`,
        action:   p.id === 'email'
          ? 'Connect an SES/SNS bounce + complaint webhook — delivery status and suppression are not tracked, so email stops at "accepted".'
          : `${p.label} does not report delivery status.`,
      })
    }
  }
  return out
}
