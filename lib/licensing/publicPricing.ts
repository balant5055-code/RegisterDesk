// RD-PRICING-CALC · the PUBLIC pricing estimate — PURE + client-safe. No Firestore, no React.
//
// ═══ THIS IS NOT A SECOND PRICING ENGINE ═════════════════════════════════════
// It composes, unchanged, the exact functions License & Services uses to quote a NEW event
// (POST /api/licensing/checkout/quote, draft mode, nothing paid yet):
//
//   registrations  calculateActivationQuote({ capacity, terms })            lib/licensing/capacityPricing
//   each service   validateServiceQuantity → priceServiceItem(kind, q, cfg)  lib/licensing/serviceAllowances
//   photos         + checkPhotoPurchase(0, q)  (a new event holds 0 photos)  lib/licensing/photoCapacity
//   totals         base / GST / total summed across the lines, exactly as that route sums them
//
// Every number — free allowance, per-unit rates, GST, minimums, maximums — arrives in the
// `PublicPricingConfig` the server resolved from Business Configuration (GET /api/public/pricing).
// Nothing here knows a price. If the configuration says X, this computes with X.

import { type CommercialTerms } from './capacityCommercial'
import { calculateActivationQuote, formatPaise, type CapacityQuote } from './capacityPricing'
import {
  SERVICE_KINDS, NOT_FOR_SALE, validateServiceQuantity, priceServiceItem, sumServiceItems,
  type PrepaidServiceConfig, type ServiceChargeItem, type ServiceKind, type ServiceSaleState,
} from './serviceAllowances'
import { checkPhotoPurchase, MAX_EVENT_PHOTO_CAPACITY } from './photoCapacity'

// ─── The sanitized public payload ─────────────────────────────────────────────

/** One service as the public page may see it: its sale configuration only when it is on sale. */
export type PublicServicePricing =
  | { available: true;  config: PrepaidServiceConfig }
  | { available: false; state: Exclude<ServiceSaleState, 'available'> }

/**
 * The REGISTERDESK PLATFORM FEE on a PAID ticket, exactly as the checkout resolves it for a new
 * sale (resolveFeeConfig for the canonical fee plan): percent of the ticket amount (+ a fixed amount,
 * clamped to [min, max] — both 0 for ticket sales since RD-FEE-01), with GST charged on the fee.
 * Payment-gateway charges are the payment provider's, separate, and NOT part of this figure.
 */
export interface PublicTicketFee {
  percent:        number
  fixedPaise:     number
  minPaise:       number
  maxPaise:       number
  gstRatePercent: number
}

/**
 * Everything the public /pricing page needs, and nothing else. Built by the server from the same
 * resolvers License & Services and the ticket checkout charge with; never read from Firestore by
 * the browser.
 */
export interface PublicPricingConfig {
  /** The GLOBAL commercial terms a new event is activated under. */
  terms:     CommercialTerms
  services:  Record<ServiceKind, PublicServicePricing>
  ticketFee: PublicTicketFee
}

/** A percentage for display: 2.5 → "2.5", 18 → "18" (no trailing ".0"). */
export const formatPercent = (n: number): string => String(Number(n.toFixed(2)))

/** What the page says when the platform fee is switched off (RD-FEE-02). */
export const NO_PLATFORM_FEE = 'No RegisterDesk platform fee'

/** True when a paid ticket is charged any platform fee at all (false ⇒ the platform fee is switched off). */
export function hasTicketFee(fee: PublicTicketFee): boolean {
  return fee.percent > 0 || fee.fixedPaise > 0 || fee.minPaise > 0
}

/**
 * The REGISTERDESK PLATFORM FEE as one phrase, built ONLY from the resolved fee — e.g.
 * "0.5% on paid ticket sales + GST" (RD-FEE-01/02: percentage only, no fixed part). It never
 * includes payment-gateway charges, which are separate. A component that is zero is omitted; a
 * minimum is mentioned only when it can actually bind (above the fixed part); a cap only when set.
 */
export function formatTicketFee(fee: PublicTicketFee): string {
  const parts: string[] = []
  if (fee.percent > 0)    parts.push(`${formatPercent(fee.percent)}%`)
  if (fee.fixedPaise > 0) parts.push(formatPaise(fee.fixedPaise))
  if (parts.length === 0 && fee.minPaise <= 0) return NO_PLATFORM_FEE
  let s = parts.length ? `${parts.join(' + ')} on paid ticket sales` : 'On paid ticket sales'
  if (fee.minPaise > fee.fixedPaise) s += ` (minimum ${formatPaise(fee.minPaise)})`
  if (fee.maxPaise > 0) s += `, capped at ${formatPaise(fee.maxPaise)}`
  if (fee.gstRatePercent > 0) s += ' + GST'
  return s
}

// ─── Estimate ─────────────────────────────────────────────────────────────────

export interface EstimateSelection {
  registrations: number
  whatsapp:      number
  certificates:  number
  media:         number
}

export type RegistrationLine =
  | { ok: true;  quote: CapacityQuote }
  | { ok: false; code: string; message: string }

export type ServiceLine =
  | { ok: true;  item: ServiceChargeItem | null }       // null ⇒ quantity 0 (not buying)
  | { ok: false; code: string; message: string }

export interface PricingEstimate {
  registrations: RegistrationLine
  services:      Record<ServiceKind, ServiceLine>
  /** Null when ANY line is invalid — an estimate with a refused line is not shown as a total. */
  totals:        { basePaise: number; gstPaise: number; totalPaise: number } | null
}

/** The service configuration the checkout would price with; a service not on sale cannot be priced. */
export function serviceConfigFor(config: PublicPricingConfig, kind: ServiceKind): PrepaidServiceConfig {
  const s = config.services[kind]
  return s.available ? s.config : NOT_FOR_SALE
}

/**
 * Price a new event's selection with the License & Services rules. Pure and deterministic.
 * Invalid input is refused per line (never coerced, never priced as free).
 */
export function estimateEventCost(config: PublicPricingConfig, selection: EstimateSelection): PricingEstimate {
  const q = calculateActivationQuote({ capacity: selection.registrations, terms: config.terms })
  const registrations: RegistrationLine = q.ok ? { ok: true, quote: q.quote } : { ok: false, code: q.code, message: q.message }

  const services = {} as Record<ServiceKind, ServiceLine>
  const items: ServiceChargeItem[] = []
  for (const kind of SERVICE_KINDS) {
    const cfg   = serviceConfigFor(config, kind)
    const check = validateServiceQuantity(kind, selection[kind], cfg)
    if (!check.ok) { services[kind] = { ok: false, code: check.code, message: check.message }; continue }
    // A new event holds no photos yet, so the whole selection must fit under the per-event maximum.
    if (kind === 'media' && check.quantity > 0) {
      const fits = checkPhotoPurchase(0, check.quantity)
      if (!fits.ok) { services[kind] = { ok: false, code: fits.code, message: fits.message }; continue }
    }
    const item = check.quantity > 0 ? priceServiceItem(kind, check.quantity, cfg) : null
    if (item) items.push(item)
    services[kind] = { ok: true, item }
  }

  const allValid = registrations.ok && SERVICE_KINDS.every(k => services[k].ok)
  const cap = registrations.ok ? registrations.quote : null
  const totals = allValid && cap ? {
    basePaise:  cap.basePaise + items.reduce((n, i) => n + i.basePaise, 0),
    gstPaise:   cap.gstPaise  + items.reduce((n, i) => n + i.gstPaise, 0),
    totalPaise: cap.totalPaise + sumServiceItems(items),
  } : null

  return { registrations, services, totals }
}

// ─── Quantity limits for the controls (derived, never invented) ──────────────

export interface QuantityLimits {
  min: number
  /** Null ⇒ the configuration sets no maximum. */
  max: number | null
}

/** Registrations: 1 … the configured maximum event capacity (the activation quote's own bounds). */
export function registrationLimits(config: PublicPricingConfig): QuantityLimits {
  return { min: 1, max: config.terms.maximumEventCapacity }
}

/**
 * A service: 0 (not buying) … its configured maximum. Photos are additionally bounded by the
 * per-event photo maximum, the same shared constant every photo purchase is checked against.
 */
export function serviceLimits(config: PublicPricingConfig, kind: ServiceKind): QuantityLimits {
  const cfg = serviceConfigFor(config, kind)
  let max = cfg.maxQuantity
  if (kind === 'media') max = max === null ? MAX_EVENT_PHOTO_CAPACITY : Math.min(max, MAX_EVENT_PHOTO_CAPACITY)
  return { min: 0, max }
}

// ─── Payload validation (the browser trusts nothing it is sent) ──────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Accept a fetched payload only if it is a complete, well-formed PublicPricingConfig. A
 * malformed or partial payload is refused — the page then shows "unavailable", never a guess.
 */
export function parsePublicPricingConfig(raw: unknown): PublicPricingConfig | null {
  if (!isObj(raw) || !isObj(raw.terms) || !isObj(raw.services)) return null
  // The activation quote validates the full terms itself; probe it once so bad terms never render.
  const probe = calculateActivationQuote({ capacity: 1, terms: raw.terms as unknown as CommercialTerms })
  if (!probe.ok) return null
  const services = {} as Record<ServiceKind, PublicServicePricing>
  for (const kind of SERVICE_KINDS) {
    const s = raw.services[kind]
    if (!isObj(s) || typeof s.available !== 'boolean') return null
    if (s.available) {
      if (!isObj(s.config)) return null
      services[kind] = { available: true, config: s.config as unknown as PrepaidServiceConfig }
    } else {
      services[kind] = { available: false, state: (typeof s.state === 'string' ? s.state : 'unavailable') as Exclude<ServiceSaleState, 'available'> }
    }
  }
  const f = raw.ticketFee
  const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!isObj(f) || !['percent', 'fixedPaise', 'minPaise', 'maxPaise', 'gstRatePercent'].every(k => nonNeg(f[k]))) return null
  const ticketFee: PublicTicketFee = {
    percent: f.percent as number, fixedPaise: f.fixedPaise as number, minPaise: f.minPaise as number,
    maxPaise: f.maxPaise as number, gstRatePercent: f.gstRatePercent as number,
  }
  return { terms: raw.terms as unknown as CommercialTerms, services, ticketFee }
}
