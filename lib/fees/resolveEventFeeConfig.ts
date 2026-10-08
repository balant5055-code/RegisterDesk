// Server-only. RD-PHASE4-S3 · Q2/Q3 — the attendee fee config for ONE event's checkout.
//
// The single place an event's own commercial terms reach the attendee fee:
//   • `events/{slug}.commercial.attendeeTransactionFeePercent`, when a Super Admin set it, replaces
//     the EFFECTIVE GLOBAL attendee transaction fee percentage for that event — and only that.
//     GST, the gateway percentage and the global platform-fee switch keep their global sources
//     (resolveFeeConfig), and the global precedence itself is unchanged. (RD-FEE-01: ticket sales
//     carry no fixed/minimum part — resolveFeeConfig zeroes it.)
//   • no (or a cleared) event value ⇒ the global percentage is INHERITED.
//   • the event record could not be read ⇒ the checkout is REFUSED (never a silent fall-back to global).
//
// The event is read HERE, server-side, by its slug — no client-supplied price, rate or fee is ever
// an input. Legacy `adminOverride` / `organizerOverride` are deliberately NOT read: they are retired
// as pricing layers (Q4); `events/{slug}.commercial` is the single event pricing layer.

import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { getFeePlanForOrganizer } from '@/lib/billing/feeEngine'
import { DEFAULT_COMMERCIAL_TERMS, validateCommercialTerms } from '@/lib/licensing/capacityCommercial'
import { resolveFeeConfig } from './resolveFeeConfig'
import type { FeeConfig, PlatformPlanTier } from './types'

export type EventFeeResolution =
  | {
      ok: true
      /** 'event' ⇒ the event's own percentage applied; 'global' ⇒ inherited. */
      source: 'event' | 'global'
      planTier:    PlatformPlanTier
      feeConfigId: string
      config:      FeeConfig
      /** The event's configured percentage, or null when it inherits. */
      eventAttendeeFeePercent: number | null
    }
  | { ok: false; reason: 'EVENT_CONTEXT_MISSING' | 'EVENT_READ_FAILED' | 'PRICING_RESOLUTION_FAILED' }

/** Stable, safe public refusal for a checkout / preview whose pricing could not be resolved. */
export const PRICING_UNAVAILABLE = {
  code:    'PRICING_UNAVAILABLE',
  message: 'We couldn’t load this event’s pricing right now. Nothing was charged — please try again in a moment.',
} as const

/**
 * The event's attendee fee percentage: a number when validly configured, null when absent or cleared
 * (inherit). A stored value that fails the SAME validator the Super Admin write uses (0..100, finite)
 * is ignored — exactly how every other commercial term is read — and reported.
 */
export function readEventAttendeeFeePercent(commercial: unknown): { value: number | null; invalid: boolean } {
  if (typeof commercial !== 'object' || commercial === null || Array.isArray(commercial)) return { value: null, invalid: false }
  const raw = (commercial as Record<string, unknown>).attendeeTransactionFeePercent
  if (raw === undefined || raw === null) return { value: null, invalid: false }
  const ok = validateCommercialTerms({ ...DEFAULT_COMMERCIAL_TERMS, attendeeTransactionFeePercent: raw }).length === 0
  return ok ? { value: raw as number, invalid: false } : { value: null, invalid: true }
}

export async function resolveEventFeeConfig(eventSlug: string | null | undefined): Promise<EventFeeResolution> {
  const slug = typeof eventSlug === 'string' ? eventSlug.trim() : ''
  if (!slug) return { ok: false, reason: 'EVENT_CONTEXT_MISSING' }

  let snap: FirebaseFirestore.DocumentSnapshot
  try {
    snap = await adminDb.collection('events').doc(slug).get()
  } catch (err) {
    // A FAILED read is not "no override": refuse, never price from global by accident.
    captureFinancialError(err, { scope: 'pricing.event_fee_read_failed', eventSlug: slug })
    return { ok: false, reason: 'EVENT_READ_FAILED' }
  }
  if (!snap.exists) return { ok: false, reason: 'EVENT_CONTEXT_MISSING' }

  const data = (snap.data() ?? {}) as Record<string, unknown>
  const pct  = readEventAttendeeFeePercent(data.commercial)
  if (pct.invalid) {
    captureFinancialError(new Error('invalid stored event attendeeTransactionFeePercent — inheriting global'), {
      scope: 'pricing.event_fee_invalid', eventSlug: slug,
    })
  }

  try {
    const organizerUid = typeof data.uid === 'string' ? data.uid : ''
    const plan   = await getFeePlanForOrganizer(organizerUid)
    const config = await resolveFeeConfig('event_registration', plan.planTier, undefined, { attendeeTransactionFeePercent: pct.value })
    return {
      ok: true, source: pct.value === null ? 'global' : 'event',
      planTier: plan.planTier, feeConfigId: plan.feeConfigId, config, eventAttendeeFeePercent: pct.value,
    }
  } catch (err) {
    captureFinancialError(err, { scope: 'pricing.event_fee_resolution_failed', eventSlug: slug })
    return { ok: false, reason: 'PRICING_RESOLUTION_FAILED' }
  }
}
