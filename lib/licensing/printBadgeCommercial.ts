// RD-PRINT-BILL-P2 · Print badge commercial terms — PURE. No Firestore, no network, no React.
//
// Three layers, resolved in a fixed order (approved 2026-10-10):
//   1. GLOBAL paid generation disabled            → FREE (generation is never blocked by billing)
//   2. EVENT  `enabled: false`                    → FREE for that event
//   3. EVENT  `complimentary: true`               → COMPLIMENTARY (no units will be consumed)
//   4. otherwise PAID at the event's unit price, else the global unit price
//
// The global unit price and GST rate live in Business Configuration with the other prepaid
// services (`licensing.serviceAllowances.print_badges`, GST-INCLUSIVE — see serviceAllowances.ts).
// The global switch lives in `licensing.printBadgeBilling`. The per-event override is
// `events/{slug}.printBadgeCommercial`, written only by the Super Admin route
// app/api/admin/events/[slug]/print-badges/route.ts.
//
// Nothing here charges, reserves or consumes anything: later phases read the EFFECTIVE terms
// (and snapshot them) — this module only decides what they are and where each value came from.

/** The asset types a paid badge applies to. A code constant (approved): not configurable. */
export const PRINT_BADGE_CHARGEABLE_ASSET_TYPES = ['ID_CARD', 'BADGE'] as const
export type PrintBadgeChargeableAssetType = typeof PRINT_BADGE_CHARGEABLE_ASSET_TYPES[number]
export const isChargeableBadgeAssetType = (t: unknown): t is PrintBadgeChargeableAssetType =>
  typeof t === 'string' && (PRINT_BADGE_CHARGEABLE_ASSET_TYPES as readonly string[]).includes(t)

/**
 * Code gate for PAID GENERATION (approved: keep paid generation disabled). Until generation
 * billing exists and is released, `paidGenerationEnabled` cannot be switched on (the Business
 * Configuration route refuses it) and — should a stored document say otherwise — the resolver
 * still treats paid generation as disabled, i.e. FREE. Never configurable.
 */
export const PAID_BADGE_GENERATION_RELEASED = false

// ─── Global switch: licensing.printBadgeBilling ───────────────────────────────

export interface PrintBadgeBillingConfig {
  /** Global master switch for PAID badge generation. Off ⇒ badge generation is free. */
  paidGenerationEnabled: boolean
  /**
   * RD-PRINT-BILL-P3 — whether a badge-purchase coupon may make a purchase FREE (a `free` coupon, or
   * any coupon whose discount covers the whole amount). Off by default; OPTIONAL in stored config
   * (absent ⇒ off), so a group stored before Phase 3 stays valid and unchanged.
   */
  allowFreeCoupons?:     boolean
}
export const PRINT_BADGE_BILLING_KEYS = ['paidGenerationEnabled', 'allowFreeCoupons'] as const
export const DEFAULT_PRINT_BADGE_BILLING: Readonly<Required<PrintBadgeBillingConfig>> = Object.freeze({ paidGenerationEnabled: false, allowFreeCoupons: false })

export function validatePrintBadgeBilling(v: unknown, path = 'licensing.printBadgeBilling'): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path} must be an object`]
  const c = v as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(c)) if (!(PRINT_BADGE_BILLING_KEYS as readonly string[]).includes(k)) errors.push(`${path}.${k} is not a recognised setting`)
  if (typeof c.paidGenerationEnabled !== 'boolean') errors.push(`${path}.paidGenerationEnabled must be a boolean`)
  if (c.allowFreeCoupons !== undefined && typeof c.allowFreeCoupons !== 'boolean') errors.push(`${path}.allowFreeCoupons must be a boolean`)
  return errors
}

// ─── Per-event override: events/{slug}.printBadgeCommercial ───────────────────

export const EVENT_PRINT_BADGE_FIELD = 'printBadgeCommercial'
export const PRINT_BADGE_OVERRIDE_KEYS = ['enabled', 'unitPricePaise', 'complimentary', 'couponsAllowed'] as const
export type PrintBadgeOverrideKey = typeof PRINT_BADGE_OVERRIDE_KEYS[number]
/** Approved bounds for an event's unit price override — whole paise, inclusive. May exceed the global price. */
export const BADGE_OVERRIDE_PRICE_MIN_PAISE = 1
export const BADGE_OVERRIDE_PRICE_MAX_PAISE = 1000

export interface PrintBadgeCommercialOverride {
  /** false ⇒ paid billing is OFF for this event (badges are free). Absent ⇒ follows global. */
  enabled?:        boolean
  /** GST-INCLUSIVE unit price for this event, whole paise 1–1,000. Absent ⇒ the global price. Never 0. */
  unitPricePaise?: number
  /** true ⇒ complimentary badges for this event (no units consumed). */
  complimentary?:  boolean
  /** false ⇒ badge coupons cannot be used for this event. Absent ⇒ allowed. */
  couponsAllowed?: boolean
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isPriceOverride = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= BADGE_OVERRIDE_PRICE_MIN_PAISE && v <= BADGE_OVERRIDE_PRICE_MAX_PAISE

function fieldError(k: PrintBadgeOverrideKey, v: unknown, path: string): string | null {
  if (k === 'unitPricePaise') {
    return isPriceOverride(v) ? null
      : `${path}.unitPricePaise must be a whole number of paise from ${BADGE_OVERRIDE_PRICE_MIN_PAISE} to ${BADGE_OVERRIDE_PRICE_MAX_PAISE} (₹${(BADGE_OVERRIDE_PRICE_MIN_PAISE / 100).toFixed(2)}–₹${(BADGE_OVERRIDE_PRICE_MAX_PAISE / 100).toFixed(2)})`
  }
  return isBool(v) ? null : `${path}.${k} must be true or false`
}

/** Validates a COMPLETE stored override (no unknown keys; every present field well-typed). */
export function validatePrintBadgeOverride(v: unknown, path = EVENT_PRINT_BADGE_FIELD): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path} must be an object`]
  const c = v as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(c)) {
    if (!(PRINT_BADGE_OVERRIDE_KEYS as readonly string[]).includes(k)) { errors.push(`${path}.${k} is not a recognised setting`); continue }
    if (c[k] === undefined) continue
    const e = fieldError(k as PrintBadgeOverrideKey, c[k], path)
    if (e) errors.push(e)
  }
  return errors
}

/** A stored override as read: valid (possibly absent ⇒ null), or invalid with its errors. */
export type StoredOverrideRead =
  | { ok: true;  override: PrintBadgeCommercialOverride | null }
  | { ok: false; errors: string[] }

export function readStoredPrintBadgeOverride(raw: unknown): StoredOverrideRead {
  if (raw === undefined || raw === null) return { ok: true, override: null }
  const errors = validatePrintBadgeOverride(raw)
  if (errors.length > 0) return { ok: false, errors }
  const c = raw as Record<string, unknown>
  const out: PrintBadgeCommercialOverride = {}
  for (const k of PRINT_BADGE_OVERRIDE_KEYS) if (c[k] !== undefined) (out as Record<string, unknown>)[k] = c[k]
  return { ok: true, override: Object.keys(out).length > 0 ? out : null }
}

/**
 * A change request as a PATCH over the stored override (same semantics as the capacity
 * `commercial` route): a value sets the field; `null` REMOVES it (the event inherits); absent
 * keeps it. Unknown keys and wrongly-typed values are refused — a `0` price is never "inherit".
 */
export type PrintBadgeOverridePatch = Partial<Record<PrintBadgeOverrideKey, boolean | number | null>>

export function parsePrintBadgeOverridePatch(raw: unknown):
  | { ok: true; patch: PrintBadgeOverridePatch }
  | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'override must be an object, or pass clear: true' }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter(k => !(PRINT_BADGE_OVERRIDE_KEYS as readonly string[]).includes(k))
  if (unknown.length > 0) return { ok: false, error: `Unknown setting: ${unknown.join(', ')}` }
  const patch: PrintBadgeOverridePatch = {}
  const errors: string[] = []
  for (const k of PRINT_BADGE_OVERRIDE_KEYS) {
    const v = r[k]
    if (v === undefined) continue
    if (v === null) { patch[k] = null; continue }
    const e = fieldError(k, v, 'override')
    if (e) errors.push(e)
    else patch[k] = v as boolean | number
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'No recognised print badge settings were supplied' }
  return { ok: true, patch }
}

/** The override that results from applying `patch` (or clearing) — null when nothing is left. */
export function applyPrintBadgeOverridePatch(
  stored: PrintBadgeCommercialOverride | null, patch: PrintBadgeOverridePatch, clear: boolean,
): PrintBadgeCommercialOverride | null {
  if (clear) return null
  const next: Record<string, unknown> = { ...(stored ?? {}) }
  for (const k of PRINT_BADGE_OVERRIDE_KEYS) {
    const v = patch[k]
    if (v === undefined) continue
    if (v === null) delete next[k]
    else next[k] = v
  }
  return Object.keys(next).length > 0 ? next as PrintBadgeCommercialOverride : null
}

/** The override fields whose stored value differs between `before` and `after`. */
export function changedPrintBadgeOverrideFields(
  before: PrintBadgeCommercialOverride | null, after: PrintBadgeCommercialOverride | null,
): PrintBadgeOverrideKey[] {
  return PRINT_BADGE_OVERRIDE_KEYS.filter(k => before?.[k] !== after?.[k])
}

/** A change that makes badges free or complimentary for an event — audited as such. */
export function isFreeOrComplimentarySetting(after: PrintBadgeCommercialOverride | null): boolean {
  return after?.enabled === false || after?.complimentary === true
}

// ─── Effective terms ──────────────────────────────────────────────────────────

export interface GlobalPrintBadgeTerms {
  /** licensing.printBadgeBilling.paidGenerationEnabled */
  paidGenerationEnabled: boolean
  /** licensing.serviceAllowances.print_badges.unitPricePaise — GST-INCLUSIVE; null ⇒ not configured. */
  unitPricePaise:        number | null
  /** licensing.serviceAllowances.print_badges.gstRatePercent — null ⇒ not configured (never assumed). */
  gstRatePercent:        number | null
}

export type PrintBadgeBillingMode = 'free' | 'complimentary' | 'paid'
export type PrintBadgeModeReason =
  | 'global_disabled'     // global paid generation off (or not released in code)
  | 'override_invalid'    // the stored event override is unreadable — fails toward NOT charging
  | 'event_disabled'      // the event switched paid billing off
  | 'complimentary'       // the event is complimentary
  | 'paid'
  | 'not_in_pilot'        // RD-PRINT-P8 — the organizer is not a paid ID-badge pilot (printBadgePilot.ts) ⇒ free

export type PrintBadgeValueSource = 'global' | 'event' | 'default'

export interface EffectivePrintBadgeTerms {
  mode:            PrintBadgeBillingMode
  reason:          PrintBadgeModeReason
  /** True only when mode is 'paid'. Free and complimentary never charge. */
  chargeable:      boolean
  /** The GST-inclusive unit price that applies to this event (reported in every mode). */
  unitPricePaise:  number | null
  gstRatePercent:  number | null
  couponsAllowed:  boolean
  /** Paid billing needs BOTH a unit price and a configured GST rate. */
  priceConfigured: boolean
  sources: { mode: PrintBadgeValueSource; unitPricePaise: PrintBadgeValueSource; couponsAllowed: PrintBadgeValueSource }
}

/**
 * The effective terms for one event — what every caller uses. Pure; never throws.
 * `storedOverride` is the RAW `events/{slug}.printBadgeCommercial` value (validated here).
 * Applies the code gate first: while PAID_BADGE_GENERATION_RELEASED is false, every event is
 * FREE ('global_disabled') whatever is stored.
 */
export function resolveEffectivePrintBadgeTerms(global: GlobalPrintBadgeTerms, storedOverride: unknown): EffectivePrintBadgeTerms {
  return printBadgePrecedence(PAID_BADGE_GENERATION_RELEASED ? global : { ...global, paidGenerationEnabled: false }, storedOverride)
}

/**
 * The precedence rules WITHOUT the code release gate — exported only so the rules can be tested
 * while paid generation is unreleased. Never call it to decide billing: use
 * resolveEffectivePrintBadgeTerms (a contract test pins that only this module and tests use it).
 * A corrupt override fails toward NOT charging (mode 'free', reason 'override_invalid') — it can
 * never raise a price or switch billing on — and is reported so a Super Admin can correct it.
 */
export function printBadgePrecedence(global: GlobalPrintBadgeTerms, storedOverride: unknown): EffectivePrintBadgeTerms {
  const read = readStoredPrintBadgeOverride(storedOverride)
  const ov = read.ok ? read.override : null
  const unitFromEvent = ov?.unitPricePaise !== undefined
  const unitPricePaise = unitFromEvent ? ov!.unitPricePaise! : global.unitPricePaise
  const couponsFromEvent = ov?.couponsAllowed !== undefined
  const base = {
    unitPricePaise,
    gstRatePercent:  global.gstRatePercent,
    couponsAllowed:  couponsFromEvent ? ov!.couponsAllowed! : true,
    priceConfigured: typeof unitPricePaise === 'number' && Number.isInteger(unitPricePaise) && unitPricePaise > 0
      && typeof global.gstRatePercent === 'number' && Number.isFinite(global.gstRatePercent)
      && global.gstRatePercent >= 0 && global.gstRatePercent <= 100,
  }
  const sources = (mode: PrintBadgeValueSource) => ({
    mode,
    unitPricePaise: (unitFromEvent ? 'event' : 'global') as PrintBadgeValueSource,
    couponsAllowed: (couponsFromEvent ? 'event' : 'default') as PrintBadgeValueSource,
  })
  const free = (reason: PrintBadgeModeReason, mode: PrintBadgeValueSource): EffectivePrintBadgeTerms =>
    ({ mode: 'free', reason, chargeable: false, ...base, sources: sources(mode) })

  // 1. Global paid generation disabled ⇒ free.
  if (global.paidGenerationEnabled !== true) return free('global_disabled', 'global')
  // A corrupt override never charges.
  if (!read.ok) return free('override_invalid', 'event')
  // 2. The event switched paid billing off ⇒ free for that event.
  if (ov?.enabled === false) return free('event_disabled', 'event')
  // 3. Complimentary ⇒ no units consumed.
  if (ov?.complimentary === true) {
    return { mode: 'complimentary', reason: 'complimentary', chargeable: false, ...base, sources: sources('event') }
  }
  // 4. Paid at the event price, else the global price.
  return { mode: 'paid', reason: 'paid', chargeable: true, ...base, sources: sources('global') }
}
