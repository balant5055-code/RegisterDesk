// RD-EVENT-COMMERCE-02 · Prepaid service allowances — PURE. No Firestore, no network, no React.
//
// ═══ WHAT THIS IS ════════════════════════════════════════════════════════════
// An organizer may prepay, per event, for a QUANTITY of a service (WhatsApp attendee
// messages, certificates) on the License & Services step, in the same Razorpay payment as the
// capacity activation. The purchased quantity becomes an event-scoped ALLOWANCE in its own
// ledger (`eventServiceAllowances/{draftId}`) — never in the communication wallet
// (`organizerWallets`), never in the revenue wallet (`organizerRevenueWallets`).
//
// ═══ APPROVED DEFAULTS (RD-EVENT-COMMERCE-05A) ═══════════════════════════════
// The business approved default prices (GST-exclusive, 18% GST) — WhatsApp ₹0.20 / message,
// certificate ₹1.50, photo ₹1.60 (RD-PRICE-01, 2026-10-07; were ₹1.90 / ₹1.90) — with sales ENABLED,
// exhaustion = block, minimum 1
// and NO RegisterDesk maximum (confirmed: an unset maximum means "no cap"; Razorpay's own
// per-order limit still applies). They are DEFAULTS, not constants: a Super Admin edits them in
// Business Configuration (`licensing.serviceAllowances`), and any STORED field — including an
// explicit null — always wins over its default, so a deliberately saved value is never
// overwritten. A stored configuration that is unusable is never sold (see NOT_FOR_SALE).
//
// Rates are GST-EXCLUSIVE, exactly like the capacity activation rate: GST is computed on the
// base and added, once, with the same rounding (`applyPercentPaise`). All money is integer
// paise.
//
// ═══ CONSUMPTION POINT (established from existing behaviour, not invented) ═══
//   • WhatsApp     one unit per message the provider ACCEPTS — the point at which the existing
//                  pay-as-you-go path charges the communication wallet. A send that fails, or
//                  whose outcome is unknown, consumes nothing (PAYG charges nothing then either).
//                  Broadcasts consume one unit per recipient at campaign start — the point at
//                  which the existing path charges the wallet for a broadcast.
//   • Certificates one unit per certificate ISSUED (record created) — the point at which
//                  lib/certificates/billing.ts charges today. Re-issue of an existing tuple,
//                  previews, downloads and emails consume nothing.
//   • Media        one unit = ONE stored photo for this event (RD-PHOTO-01): an event's photo
//                  capacity is exactly the units paid for on it — NO free base — and its total
//                  may never exceed MAX_EVENT_PHOTO_CAPACITY (3,000, lib/licensing/photoCapacity.ts),
//                  enforced at quote, order creation and settlement. Consumed at upload prepare
//                  (one pending/ready photo = one unit). The account-level Media Credits wallet is
//                  retired and grants nothing.

import { applyPercentPaise } from './capacityPricing'

export const SERVICE_KINDS = ['whatsapp', 'certificates', 'media'] as const
export type ServiceKind = typeof SERVICE_KINDS[number]

/** What happens to a send/issuance once the event's purchased allowance is used up. */
export type AllowanceExhaustionPolicy = 'block' | 'wallet_payg'
export const EXHAUSTION_POLICIES: AllowanceExhaustionPolicy[] = ['block', 'wallet_payg']

export interface PrepaidServiceConfig {
  /** Master switch for SELLING this allowance. Existing allowances keep working when off. */
  enabled:        boolean
  /** Price of one unit in paise, EXCLUDING GST. null ⇒ not configured. */
  unitPricePaise: number | null
  /** GST percent applied to the base. null ⇒ not configured (never assumed). */
  gstRatePercent: number | null
  /** Smallest purchasable quantity (a purchase of 0 means "none"). */
  minQuantity:    number
  /** Largest purchasable quantity per purchase. null ⇒ NO RegisterDesk maximum (05A, confirmed). */
  maxQuantity:    number | null
  /** Quick-select values shown beside the input. Presentation only — never a price. */
  presets:        number[]
  /** Behaviour once the allowance is exhausted. null ⇒ not configured. */
  onExhausted:    AllowanceExhaustionPolicy | null
}

export type ServiceAllowancesConfig = Record<ServiceKind, PrepaidServiceConfig>

const UNCONFIGURED: PrepaidServiceConfig = {
  enabled: false, unitPricePaise: null, gstRatePercent: null,
  minQuantity: 1, maxQuantity: null, presets: [], onExhausted: null,
}

/**
 * A configuration that can NEVER be sold — used for a service whose stored value is unusable
 * or unreadable. Deliberately NOT the defaults: a broken configuration must fail closed, not
 * silently fall back to the approved prices.
 */
export const NOT_FOR_SALE: Readonly<PrepaidServiceConfig> = Object.freeze({ ...UNCONFIGURED })

/** RD-EVENT-COMMERCE-05A — the approved default prices, GST, and sale settings (editable). */
export const DEFAULT_SERVICE_ALLOWANCES: ServiceAllowancesConfig = {
  whatsapp:     { enabled: true, unitPricePaise: 20,  gstRatePercent: 18, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: 'block' },
  certificates: { enabled: true, unitPricePaise: 150, gstRatePercent: 18, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: 'block' },
  media:        { enabled: true, unitPricePaise: 160, gstRatePercent: 18, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: 'block' },
}

export const SERVICE_LABELS: Record<ServiceKind, { title: string; unit: string; units: string }> = {
  whatsapp:     { title: 'WhatsApp message allowance', unit: 'message',     units: 'messages' },
  certificates: { title: 'Certificate allowance',      unit: 'certificate', units: 'certificates' },
  media:        { title: 'Event photo capacity',       unit: 'photo',       units: 'photos' },
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Validation shared by Business Configuration (so an invalid config can never be saved). */
export function validateServiceAllowances(v: unknown, path = 'licensing.serviceAllowances'): string[] {
  const errors: string[] = []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path} must be an object`]
  const c = v as Record<string, unknown>
  for (const kind of SERVICE_KINDS) {
    const p = `${path}.${kind}`
    const s = c[kind] as Partial<PrepaidServiceConfig> | undefined
    if (typeof s !== 'object' || s === null || Array.isArray(s)) { errors.push(`${p} must be an object`); continue }
    if (typeof s.enabled !== 'boolean') errors.push(`${p}.enabled must be a boolean`)
    if (!(s.unitPricePaise === null || (isInt(s.unitPricePaise) && s.unitPricePaise > 0))) errors.push(`${p}.unitPricePaise must be a positive integer (paise) or null`)
    if (!(s.gstRatePercent === null || (typeof s.gstRatePercent === 'number' && Number.isFinite(s.gstRatePercent) && s.gstRatePercent >= 0 && s.gstRatePercent <= 100))) errors.push(`${p}.gstRatePercent must be 0..100 or null`)
    if (!(isInt(s.minQuantity) && s.minQuantity >= 1)) errors.push(`${p}.minQuantity must be an integer ≥ 1`)
    if (!(s.maxQuantity === null || (isInt(s.maxQuantity) && s.maxQuantity >= 1))) errors.push(`${p}.maxQuantity must be a positive integer, or empty for no maximum`)
    if (isInt(s.minQuantity) && isInt(s.maxQuantity) && s.maxQuantity < s.minQuantity) errors.push(`${p}.maxQuantity cannot be below minQuantity`)
    if (!(Array.isArray(s.presets) && s.presets.every(x => isInt(x) && x >= 1))) errors.push(`${p}.presets must be an array of positive integers`)
    if (!(s.onExhausted === null || (typeof s.onExhausted === 'string' && (EXHAUSTION_POLICIES as string[]).includes(s.onExhausted)))) errors.push(`${p}.onExhausted must be ${EXHAUSTION_POLICIES.join(' | ')} or null`)
  }
  return errors
}

/**
 * Absent / partial stored config ⇒ each ABSENT field takes its approved default
 * (DEFAULT_SERVICE_ALLOWANCES); every STORED field — including an explicit null a Super Admin
 * saved — is kept as stored. Nothing is validated here (see serviceAvailability / the resolver).
 */
export function normalizeServiceAllowances(v: unknown): ServiceAllowancesConfig {
  const c = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<ServiceKind, Partial<PrepaidServiceConfig>>>
  const out = {} as ServiceAllowancesConfig
  for (const kind of SERVICE_KINDS) out[kind] = { ...DEFAULT_SERVICE_ALLOWANCES[kind], ...(c[kind] ?? {}) }
  return out
}

// ─── Availability ─────────────────────────────────────────────────────────────

export interface ServiceAvailability {
  purchasable: boolean
  /** Human labels of what is missing, in the order an admin would fix them. Empty when purchasable. */
  missing:     string[]
}

/**
 * A service is purchasable only when EVERY commercial decision is configured AND valid.
 *
 * RD-EVENT-COMMERCE-04 — each field is checked for type and range here, not just for null:
 * the stored config is merged without validation (`normalizeServiceAllowances`), so a doc
 * written outside the admin API (console, script, older code) could carry `-5`, `0`, `'45'`
 * or `NaN`. Any such value makes the service NOT purchasable, never a free or negative line.
 */
export function serviceAvailability(cfg: PrepaidServiceConfig): ServiceAvailability {
  const missing: string[] = []
  const minOk = isInt(cfg.minQuantity) && cfg.minQuantity >= 1
  if (!(isInt(cfg.unitPricePaise) && cfg.unitPricePaise > 0)) missing.push('unit price')
  if (!(typeof cfg.gstRatePercent === 'number' && Number.isFinite(cfg.gstRatePercent) && cfg.gstRatePercent >= 0 && cfg.gstRatePercent <= 100)) missing.push('GST rate')
  // RD-EVENT-COMMERCE-05A — a null maximum means NO RegisterDesk cap (confirmed); a set one must be ≥ the minimum.
  if (!(minOk && (cfg.maxQuantity === null || (isInt(cfg.maxQuantity) && cfg.maxQuantity >= cfg.minQuantity)))) missing.push('quantity range')
  if (!(typeof cfg.onExhausted === 'string' && (EXHAUSTION_POLICIES as string[]).includes(cfg.onExhausted))) missing.push('exhaustion policy')
  if (cfg.enabled !== true)        missing.push('enabled for sale')
  return { purchasable: missing.length === 0, missing }
}

/**
 * RD-EVENT-COMMERCE-05 — WHY a service is or is not for sale, for the organizer page.
 *   available       — every decision set and valid, enabled for sale
 *   not_configured  — a pricing decision (unit price, GST, range, exhaustion policy) is not set
 *   disabled        — fully priced, but a Super Admin has switched sales off
 *   invalid         — the stored configuration is unusable (resolved per service; never sold)
 *   unavailable     — the configuration could not be read right now
 */
export type ServiceSaleState = 'available' | 'not_configured' | 'disabled' | 'invalid' | 'unavailable'

/** The sale state of a VALID (already per-service resolved) configuration. */
export function serviceSaleState(cfg: PrepaidServiceConfig): ServiceSaleState {
  const { purchasable, missing } = serviceAvailability(cfg)
  if (purchasable) return 'available'
  return missing.length === 1 && missing[0] === 'enabled for sale' ? 'disabled' : 'not_configured'
}

/** The organizer-facing reason a service cannot be bought — ONE wording, server and page. */
export function saleStateMessage(kind: ServiceKind, state: ServiceSaleState | 'no_photo_limit', missing: string[] = []): string {
  const units = SERVICE_LABELS[kind].units
  switch (state) {
    case 'not_configured': return `Prepaid ${units} aren’t on sale yet — RegisterDesk hasn’t set the ${missing.filter(m => m !== 'enabled for sale').join(', ') || 'pricing'}. Nothing is charged for this.`
    case 'disabled':       return `RegisterDesk has paused sales of prepaid ${units}. Nothing is charged for this.`
    case 'invalid':        return `Prepaid ${units} can’t be bought right now — RegisterDesk is correcting their pricing. Nothing is charged for this.`
    case 'unavailable':    return `Prepaid ${units} pricing couldn’t be loaded just now. Try again in a moment — nothing is charged.`
    case 'no_photo_limit': return `This event has no photo limit, so there is nothing to add ${units} to.`
    default:               return ''
  }
}

/**
 * RD-EVENT-COMMERCE-05 — SAVE-TIME readiness rules, applied when a Super Admin publishes (and
 * mirrored in the editor). Deliberately NOT part of `validateServiceAllowances`: that one also
 * runs on READ, where a stricter rule would silently turn an already-stored service into
 * "invalid". These rules stop a NEW contradictory setting from being published:
 *   • "for sale" with a pricing decision still missing is refused (the switch would do nothing);
 *   • a quick-select preset outside min…max is refused (the server would reject that button).
 */
export function serviceSaleReadinessErrors(v: unknown, path = 'licensing.serviceAllowances'): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return []
  const c = v as Record<string, Partial<PrepaidServiceConfig> | undefined>
  const errors: string[] = []
  for (const kind of SERVICE_KINDS) {
    const s = c[kind]
    if (!s || typeof s !== 'object') continue
    const label = SERVICE_LABELS[kind].title
    if (s.enabled === true) {
      const gaps = serviceAvailability({ ...UNCONFIGURED, ...s, enabled: true } as PrepaidServiceConfig).missing
      if (gaps.length > 0) errors.push(`${label}: set its ${gaps.join(', ')} before putting it on sale (${path}.${kind})`)
    }
    if (Array.isArray(s.presets) && isInt(s.minQuantity)) {
      const bad = s.presets.filter(x => isInt(x) && (x < s.minQuantity! || (isInt(s.maxQuantity) && x > s.maxQuantity)))
      if (bad.length > 0) errors.push(`${label}: quick-select ${bad.join(', ')} must lie within ${s.minQuantity}–${isInt(s.maxQuantity) ? s.maxQuantity : '∞'} (${path}.${kind}.presets)`)
    }
  }
  return errors
}

// ─── Quantity validation ──────────────────────────────────────────────────────

export type QuantityCheck =
  | { ok: true;  quantity: number }
  | { ok: false; code: 'NOT_AN_INTEGER' | 'NEGATIVE' | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'NOT_PURCHASABLE'; message: string }

/**
 * Validates a RAW requested quantity. Never coerces: `'5'`, `5.5`, `NaN`, `true` are refused,
 * because any of them could otherwise become an amount. 0 means "not buying this service" and
 * is always valid, even for an unconfigured service.
 */
export function validateServiceQuantity(kind: ServiceKind, raw: unknown, cfg: PrepaidServiceConfig): QuantityCheck {
  const label = SERVICE_LABELS[kind].units
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, code: 'NOT_AN_INTEGER', message: `The number of ${label} must be a whole number.` }
  if (raw < 0) return { ok: false, code: 'NEGATIVE', message: `The number of ${label} cannot be negative.` }
  if (raw === 0) return { ok: true, quantity: 0 }
  const avail = serviceAvailability(cfg)
  if (!avail.purchasable) return { ok: false, code: 'NOT_PURCHASABLE', message: `Prepaid ${label} can’t be purchased yet — awaiting ${avail.missing.join(', ')}.` }
  if (raw < cfg.minQuantity) return { ok: false, code: 'BELOW_MINIMUM', message: `The minimum is ${cfg.minQuantity.toLocaleString('en-IN')} ${label}.` }
  if (cfg.maxQuantity !== null && raw > cfg.maxQuantity) return { ok: false, code: 'ABOVE_MAXIMUM', message: `The maximum is ${cfg.maxQuantity.toLocaleString('en-IN')} ${label}.` }
  return { ok: true, quantity: raw }
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

/** The immutable pricing record for one service line — written onto the order. */
export interface ServiceChargeItem {
  service:        ServiceKind
  quantity:       number
  unitPricePaise: number
  basePaise:      number
  gstRatePercent: number
  gstPaise:       number
  totalPaise:     number
  /** The exhaustion policy in force when bought — travels with the allowance it creates. */
  onExhausted:    AllowanceExhaustionPolicy
  /**
   * Media lines only (2026-10-02): the event's BASE photo limit when this line was bought — the cap
   * the purchased units sit on top of. Lets the Wallet derive how many purchased photo units are used
   * (photos stored above this base) even if the live base later changes. Absent on older lines,
   * which therefore cannot be valued for a refund (Super Admin review).
   */
  baseCapAtPurchase?: number
}

/** Records the base photo limit on every media line (no-op for other services or an unknown base). */
export function withMediaBaseCap(items: ServiceChargeItem[], baseCap: number | null): ServiceChargeItem[] {
  if (baseCap === null || !Number.isInteger(baseCap) || baseCap < 0) return items
  return items.map(i => (i.service === 'media' ? { ...i, baseCapAtPurchase: baseCap } : i))
}

/** Prices `quantity` units. Caller must have validated the quantity and availability. */
export function priceServiceItem(kind: ServiceKind, quantity: number, cfg: PrepaidServiceConfig): ServiceChargeItem {
  const unit = cfg.unitPricePaise ?? 0
  const gstRatePercent = cfg.gstRatePercent ?? 0
  const basePaise = quantity * unit
  const gstPaise  = applyPercentPaise(basePaise, gstRatePercent)
  return {
    service: kind, quantity, unitPricePaise: unit, basePaise, gstRatePercent, gstPaise,
    totalPaise: basePaise + gstPaise, onExhausted: cfg.onExhausted ?? 'block',
  }
}

/** A stored line is only trusted when its own arithmetic holds (same rule as capacity snapshots). */
export function isConsistentServiceItem(i: ServiceChargeItem): boolean {
  return isInt(i.quantity) && i.quantity > 0 && isInt(i.unitPricePaise) && isInt(i.basePaise) && isInt(i.gstPaise) &&
    i.basePaise === i.quantity * i.unitPricePaise &&
    i.gstPaise === applyPercentPaise(i.basePaise, i.gstRatePercent) &&
    i.totalPaise === i.basePaise + i.gstPaise
}

export const sumServiceItems = (items: readonly ServiceChargeItem[] | undefined | null): number =>
  (items ?? []).reduce((s, i) => s + i.totalPaise, 0)

// ─── Selection & coverage ─────────────────────────────────────────────────────

export type ServiceSelection = Record<ServiceKind, number>
export const EMPTY_SELECTION: ServiceSelection = { whatsapp: 0, certificates: 0, media: 0 }

/** Purchased quantities per service, as recorded by the allowance ledger. */
export type ServicePurchased = Record<ServiceKind, number>

/** Units still to be bought for `selected` given `purchased` (never negative). */
export function serviceShortfall(selected: ServiceSelection, purchased: ServicePurchased): ServiceSelection {
  const out = { ...EMPTY_SELECTION }
  for (const k of SERVICE_KINDS) out[k] = Math.max(0, (selected[k] ?? 0) - (purchased[k] ?? 0))
  return out
}

export const selectionIsEmpty = (s: ServiceSelection): boolean => SERVICE_KINDS.every(k => (s[k] ?? 0) === 0)

/** Parse a raw `{ whatsapp, certificates }` body field. Unknown keys are refused. */
export function parseServiceSelection(raw: unknown): { ok: true; selection: ServiceSelection } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, selection: { ...EMPTY_SELECTION } }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'services must be an object of quantities.' }
  const r = raw as Record<string, unknown>
  for (const key of Object.keys(r)) if (!(SERVICE_KINDS as readonly string[]).includes(key)) return { ok: false, message: `Unknown service '${key}'.` }
  const selection = { ...EMPTY_SELECTION }
  for (const k of SERVICE_KINDS) {
    const v = r[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { ok: false, message: `The ${SERVICE_LABELS[k].units} quantity must be a whole number of 0 or more.` }
    selection[k] = v
  }
  return { ok: true, selection }
}
