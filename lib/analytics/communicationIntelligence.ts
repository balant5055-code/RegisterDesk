// RD-ANALYTICS-12-28 · Communication Intelligence derivations. PURE — no Firestore, no React.
//
// ═══ WHAT THIS MODULE IS FOR ═════════════════════════════════════════════════
// The producer reads counts (lib/analytics/communicationsSources); this turns them into the
// `CommunicationIntelligence` block of the contract. Everything here is arithmetic over
// `number | null`, and the two rules every function obeys are the module's whole point:
//
//   • an unmeasured input yields an unmeasured output — never 0, never NaN, never Infinity
//   • a comparison is only ever made through `compareMetric`, so a missing baseline is
//     explained the same way it is everywhere else on the payload
//
// ═══ WHAT IT REFUSES TO KNOW ═════════════════════════════════════════════════
// Windowed `unknown`. The lifetime figures subtract transport timeouts out of `failed`; no
// declared index makes that subtraction possible inside a `createdAt` window, so the
// windowed figure is published as `notDelivered` (raw) and nothing here estimates, derives
// or back-fills an `unknown` for the window.

import { compareMetric, type ComparisonUnavailable, type ComparedMetric } from '@/lib/analytics/comparison'
import { rangeLengthDays, type AnalyticsDateRange } from '@/lib/analytics/dateRange'
import type {
  ChannelDelivery, CommunicationIntelligence, Count, WindowedChannelDelivery,
} from '@/lib/analytics/contract'
import type {
  CampaignCounts, CommunicationSignals, WindowedCommunicationCounts,
} from '@/lib/analytics/communicationsSources'

/** null-propagating sum: any unmeasured side makes the total unmeasured. */
const add = (a: Count, b: Count): Count => (a === null || b === null ? null : a + b)

/** Both supported channels folded into one windowed position. */
export function windowedTotals(w: WindowedCommunicationCounts): WindowedChannelDelivery {
  return {
    attempted:    add(w.email.attempted,    w.whatsapp.attempted),
    delivered:    add(w.email.delivered,    w.whatsapp.delivered),
    notDelivered: add(w.email.notDelivered, w.whatsapp.notDelivered),
    queued:       add(w.email.queued,       w.whatsapp.queued),
    skipped:      add(w.email.skipped,      w.whatsapp.skipped),
  }
}

/**
 * Messages attempted per day of the window.
 *
 * The denominator is the SELECTED RANGE in days — the same `rangeLengthDays` the revenue
 * velocity divides by — and the numerator is the windowed attempted count, so this is
 * "how busy was messaging in this window", nothing more. Integer, truncated. An unmeasured
 * numerator or an invalid range yields null: a velocity is a rate, and a rate over an
 * unknown or empty divisor is not 0/day.
 */
export function communicationVelocity(
  attemptedInWindow: Count,
  range: AnalyticsDateRange,
): CommunicationIntelligence['window']['velocity'] {
  const windowDays = rangeLengthDays(range.from, range.to)
  if (attemptedInWindow === null || windowDays === null || windowDays <= 0) {
    return { perDay: null, windowDays, basis: 'attempted_in_window_per_day' }
  }
  return {
    perDay: Math.trunc(attemptedInWindow / windowDays),
    windowDays,
    basis: 'attempted_in_window_per_day',
  }
}

/**
 * Share of lifetime attempted messages by channel — SUPPORTED channels only.
 *
 * Takes the same `ChannelDelivery` objects the channel table renders, so the shares are
 * of the same `sent` the reader sees beside them. Either channel unmeasured ⇒ no mix (a
 * share of an unknown total is not a share). Nothing attempted ⇒ no mix, not two zeros.
 * SMS and Push are not inputs: a channel with no transport has no share to report.
 */
export function channelMix(
  email: ChannelDelivery | null,
  whatsapp: ChannelDelivery | null,
): CommunicationIntelligence['channelMix'] {
  const e = email?.sent ?? null
  const w = whatsapp?.sent ?? null
  if (e === null || w === null) return null
  const total = e + w
  if (total <= 0) return null
  return [
    { key: 'email',    label: 'Email',    attempted: e, sharePct: Math.round((e / total) * 100) },
    { key: 'whatsapp', label: 'WhatsApp', attempted: w, sharePct: Math.round((w / total) * 100) },
  ]
}

/**
 * The block for a producer that has NO communication data for its scope.
 *
 * The workspace-wide payload reads nothing about messaging, so every figure is unmeasured
 * and every comparison says `disabled` — not because the window is empty but because no
 * read was made. Exposed so the two producers cannot shape "nothing known" differently.
 */
export function unmeasuredCommunicationIntelligence(range: AnalyticsDateRange): CommunicationIntelligence {
  const none: WindowedChannelDelivery = {
    attempted: null, delivered: null, notDelivered: null, queued: null, skipped: null,
  }
  const off = compareMetric(null, null, 'disabled')
  return {
    campaigns:   { created: null, completed: null, scheduled: null, period: off, basis: 'broadcast_campaign_documents' },
    composition: { broadcast: null, automatic: null, basis: 'template_key_broadcast_vs_rest' },
    email:       { bounces: null, complaints: null, basis: 'provider_webhook_error_reason' },
    whatsapp:    { read: null, walletSkipped: null, basis: 'meta_status_and_wallet_skip_reason' },
    window: {
      range,
      period:   { email: none, whatsapp: none },
      baseline: null,
      attempted: off, delivered: off, notDelivered: off,
      velocity: communicationVelocity(null, range),
    },
    channelMix: null,
  }
}

/**
 * The whole block, from the producer's reads.
 *
 * `baselineReason` is decided by the producer, which knows whether the preceding window
 * was refused (predates the event), unreadable, or simply not requested. It is applied to
 * every compared metric here so the campaign and message comparisons cannot explain an
 * absent baseline two different ways.
 */
export function buildCommunicationIntelligence(args: {
  range:          AnalyticsDateRange
  campaigns:      CampaignCounts
  signals:        CommunicationSignals
  period:         WindowedCommunicationCounts
  baseline:       WindowedCommunicationCounts | null
  baselineReason: ComparisonUnavailable
  lifetimeEmail:    ChannelDelivery | null
  lifetimeWhatsapp: ChannelDelivery | null
}): CommunicationIntelligence {
  const p = windowedTotals(args.period)
  const b = args.baseline ? windowedTotals(args.baseline) : null
  const cmp = (cur: Count, base: Count): ComparedMetric =>
    compareMetric(cur, base ?? null, args.baselineReason)

  return {
    campaigns: {
      created:   args.campaigns.created,
      completed: args.campaigns.completed,
      scheduled: args.campaigns.scheduled,
      period:    cmp(args.campaigns.period, args.campaigns.baseline),
      basis:     'broadcast_campaign_documents',
    },
    composition: {
      broadcast: args.signals.broadcast,
      automatic: args.signals.automatic,
      basis:     'template_key_broadcast_vs_rest',
    },
    email: {
      bounces:    args.signals.bounces,
      complaints: args.signals.complaints,
      basis:      'provider_webhook_error_reason',
    },
    whatsapp: {
      read:          args.signals.read,
      walletSkipped: args.signals.walletSkipped,
      basis:         'meta_status_and_wallet_skip_reason',
    },
    window: {
      range:        args.range,
      period:       { email: args.period.email, whatsapp: args.period.whatsapp },
      baseline:     args.baseline ? { email: args.baseline.email, whatsapp: args.baseline.whatsapp } : null,
      attempted:    cmp(p.attempted,    b?.attempted    ?? null),
      delivered:    cmp(p.delivered,    b?.delivered    ?? null),
      notDelivered: cmp(p.notDelivered, b?.notDelivered ?? null),
      velocity:     communicationVelocity(p.attempted, args.range),
    },
    channelMix: channelMix(args.lifetimeEmail, args.lifetimeWhatsapp),
  }
}
