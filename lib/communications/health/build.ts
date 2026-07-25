// RD-COMMS-01 Phase 2 — PURE builders for channel health + readiness (isomorphic).
//
// Given already-measured signals (booleans/numbers), build the ChannelHealth dimension
// breakdown and the CommunicationReadiness verdicts. PURE — no I/O, no server imports — so
// the server resolver can feed it real runtime signals and unit tests can feed fixtures.
// Nothing here sends, charges, or mutates; it only describes truth.

import {
  CHANNEL_CAPABILITIES,
  isChannelImplemented,
  computeChannelState,
  statusForState,
  summarizeState,
  rollupStatus,
  type ChannelSignals,
} from './channels'
import type {
  ChannelHealth,
  ChannelReadiness,
  CommunicationReadiness,
  CommChannelId,
  DimensionResult,
} from './types'

function dim(
  dimension: DimensionResult['dimension'],
  status:    DimensionResult['status'],
  reason:    string,
  recommendedAction: string,
): DimensionResult {
  return { dimension, status, reason, recommendedAction }
}

/** Build the full per-channel health (state + 6-dimension breakdown) from real signals. */
export function buildChannelHealth(channel: CommChannelId, s: ChannelSignals): ChannelHealth {
  const cap         = CHANNEL_CAPABILITIES[channel]
  const implemented = isChannelImplemented(channel)
  const state       = computeChannelState(channel, s)
  const enabled     = s.event ? s.event.enabled : s.platformEnabled
  const status      = statusForState(state, enabled)

  const dimensions: DimensionResult[] = [
    // Provider
    !implemented
      ? dim('provider', 'red', `${cap.label} has no send transport implemented`, 'Not available yet — no action')
      : s.configured
        ? dim('provider', 'green', `${cap.label} provider is configured`, 'No action needed')
        : dim('provider', 'amber', `${cap.label} provider is not configured`, `Connect the ${cap.label} provider`),

    // Configuration
    !implemented
      ? dim('configuration', 'red', `${cap.label} is unavailable`, 'Not available yet — no action')
      : !s.configured
        ? dim('configuration', 'amber', `Configure the ${cap.label} provider first`, `Add ${cap.label} credentials`)
        : s.platformEnabled
          ? dim('configuration', 'green', `${cap.label} is enabled in Business Configuration`, 'No action needed')
          : dim('configuration', 'red', `${cap.label} is disabled in Business Configuration`, `Enable ${cap.label} in Business Configuration`),

    // Templates
    !implemented
      ? dim('templates', 'red', `No ${cap.label} templates (channel unavailable)`, 'Not available yet — no action')
      : s.templatesAvailable
        ? dim('templates', 'green', `${cap.label} templates are available`, 'No action needed')
        : dim('templates', 'amber', `No approved ${cap.label} template — sends fall back or skip`, `Add/approve a ${cap.label} template`),

    // Credits
    !cap.paid
      ? dim('credits', 'green', `${cap.label} is free`, 'No action needed')
      : s.funded === true
        ? dim('credits', 'green', 'Wallet balance covers sending', 'No action needed')
        : s.funded === false
          ? dim('credits', 'amber', 'Wallet balance is too low to send', 'Top up your communication wallet')
          : dim('credits', 'amber', 'Wallet balance not evaluated in this scope', 'Open the wallet to review balance'),

    // Runtime — Phase 2 exposes config-derived state; live delivery metrics are surfaced
    // in the communication logs, not fabricated here.
    dim('runtime', 'amber', 'Live delivery metrics are not summarized in this read model', 'Review the communication logs'),

    // Authentication — sender-domain / token verification probes land in a later phase.
    !implemented
      ? dim('authentication', 'red', 'No transport to authenticate', 'Not available yet — no action')
      : s.configured
        ? dim('authentication', 'amber', 'Live authentication probe not run in this phase', 'Verify sender identity / provider token')
        : dim('authentication', 'amber', 'Provider not configured', 'Configure the provider'),
  ]

  return { channel, implemented, state, status, summary: summarizeState(channel, state), dimensions }
}

// ─── Readiness ───────────────────────────────────────────────────────────────

function channelReadiness(
  channel: CommChannelId,
  s: ChannelSignals,
): ChannelReadiness {
  const cap      = CHANNEL_CAPABILITIES[channel]
  const state    = computeChannelState(channel, s)
  const enabled  = s.event ? s.event.enabled : s.platformEnabled
  const status   = statusForState(state, enabled)
  const blockers: string[] = []
  const warnings: string[] = []

  if (!cap.implemented) {
    blockers.push(`${cap.label} has no delivery provider — messages will not be sent`)
    return { channel, ready: false, state, status, blockers, warnings }
  }
  if (!s.configured)      blockers.push(`${cap.label} provider is not connected`)
  if (!s.platformEnabled) blockers.push(`${cap.label} is disabled in Business Configuration`)
  if (cap.paid && s.funded === false) warnings.push(`Wallet balance is low — ${cap.label} messages will be skipped until you top up`)
  if (!s.templatesAvailable && s.configured) warnings.push(`No approved ${cap.label} template — sends may fall back or be skipped`)

  const eventOff = s.event ? !s.event.enabled : false
  const ready = blockers.length === 0 && !(cap.paid && s.funded === false) && s.templatesAvailable && !eventOff

  return { channel, ready, state, status, blockers, warnings }
}

/** Build the per-channel + overall readiness verdict from real signals. */
export function buildCommunicationReadiness(input: {
  email:    ChannelSignals
  whatsapp: ChannelSignals
  sms:      ChannelSignals
  /** Whether certificate delivery is enabled at platform level. */
  certificateEnabled: boolean
}): CommunicationReadiness {
  const email    = channelReadiness('email', input.email)
  const whatsapp = channelReadiness('whatsapp', input.whatsapp)
  const sms      = channelReadiness('sms', input.sms)

  // Certificate is delivered over email — its readiness inherits email delivery, plus a
  // platform-enable check. It is not a transport of its own.
  const certBlockers = [...email.blockers]
  const certWarnings = [...email.warnings]
  if (!input.certificateEnabled) certWarnings.push('Certificates are disabled in Business Configuration')
  const certificate: ChannelReadiness = {
    channel: 'certificate',
    ready:   email.ready && input.certificateEnabled,
    state:   email.state,
    status:  input.certificateEnabled ? email.status : 'amber',
    blockers: certBlockers,
    warnings: certWarnings,
  }

  // Overall: email is the baseline confirmation channel; enabled paid channels contribute
  // warnings. Only structural email failure blocks overall readiness.
  const overallBlockers = [...email.blockers]
  const overallWarnings = [
    ...(whatsapp.state !== 'unavailable' ? whatsapp.warnings : []),
    ...whatsapp.blockers.map(b => `WhatsApp: ${b}`),
  ]
  const overall = {
    ready:    email.ready,
    status:   rollupStatus([email.status, whatsapp.status, certificate.status]),
    blockers: overallBlockers,
    warnings: overallWarnings,
  }

  return { email, whatsapp, sms, certificate, overall }
}
