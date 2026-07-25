// RD-PLATFORM-COMMS-02 Phase 5E — pure execution-plan projections (isomorphic, server-free).
//
// The ONE place plan numbers + validation are computed. PURE — deterministic math over
// already-resolved inputs; no I/O, no execution, no scheduling. Split out so it is testable.

import { PLAN_BATCH_SIZE } from './types'
import type { ChannelProjection, PlanValidation } from './types'

const ALL_CHANNELS: ChannelProjection['channel'][] = ['email', 'whatsapp', 'inapp', 'sms', 'push']

/** Per-channel support projection for a notification. PURE. */
export function projectChannels(supports: { email: boolean; whatsapp: boolean; inapp: boolean }): ChannelProjection[] {
  return ALL_CHANNELS.map(channel => {
    if (channel === 'sms' || channel === 'push') return { channel, supported: false, reason: 'No transport implemented (unavailable).' }
    const supported = channel === 'email' ? supports.email : channel === 'whatsapp' ? supports.whatsapp : supports.inapp
    return { channel, supported, reason: supported ? 'Template + transport available.' : 'No template for this channel.' }
  })
}

/** Batch/message projection. PURE. Returns nulls when recipients are unknown. */
export function projectBatches(recipients: number | null, channelCount: number): { messages: number | null; batches: number | null } {
  if (recipients === null || channelCount === 0) return { messages: recipients === null ? null : 0, batches: recipients === null ? null : 0 }
  const messages = recipients * channelCount
  return { messages, batches: Math.ceil(messages / PLAN_BATCH_SIZE) }
}

/** Estimated cost projection from per-channel pricing. PURE. Free channels contribute 0. */
export function projectCost(
  recipients: number | null,
  channels:   Array<{ channel: string; paid: boolean; pricePaise: number }>,
): number | null {
  if (recipients === null) return null
  return channels.reduce((sum, c) => sum + (c.paid ? c.pricePaise * recipients : 0), 0)
}

/** The composite plan validation. PURE. */
export function buildPlanValidation(i: {
  campaignFound:      boolean
  approved:           boolean
  audience:           { valid: boolean; evaluated: boolean } | null
  hasTemplate:        boolean
  unknownVariables:   string[]
  policyResolved:     boolean
  usedProvidersReady: boolean
  walletSufficient:   boolean | null
}): PlanValidation[] {
  return [
    { check: 'campaign',  ok: i.campaignFound, detail: i.campaignFound ? 'Campaign resolved.' : 'Campaign not found.' },
    { check: 'approval',  ok: i.approved, detail: i.approved ? 'Campaign is approved.' : 'Campaign is not approved — a plan is advisory until approval.' },
    { check: 'audience',  ok: !!i.audience?.valid, detail: !i.audience ? 'No audience selected.' : i.audience.valid ? (i.audience.evaluated ? 'Audience valid + evaluated.' : 'Audience valid but not evaluated (reach unknown).') : 'Audience is invalid.' },
    { check: 'templates', ok: i.hasTemplate, detail: i.hasTemplate ? 'Template available.' : 'No template for the campaign channel(s).' },
    { check: 'variables', ok: i.unknownVariables.length === 0, detail: i.unknownVariables.length === 0 ? 'All variables registered.' : `Unknown: ${i.unknownVariables.join(', ')}` },
    { check: 'policy',    ok: i.policyResolved, detail: i.policyResolved ? 'Policy resolved.' : 'Policy could not be resolved.' },
    { check: 'providers', ok: i.usedProvidersReady, detail: i.usedProvidersReady ? 'All used channel providers are ready.' : 'One or more channel providers are not ready.' },
    { check: 'wallet',    ok: i.walletSufficient !== false, detail: i.walletSufficient === false ? 'Estimated cost exceeds available balance.' : i.walletSufficient === null ? 'No single wallet applies (platform-absorbed / per-organizer).' : 'Balance covers the estimate.' },
  ]
}
