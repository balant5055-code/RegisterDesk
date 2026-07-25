// RD-PRICING-01B — Platform Pricing Engine · type contracts.
//
// PURE module: no Firebase, no SDK, no side effects — safe to import from client or
// server. The runtime pieces (resolver.ts, service.ts) are server-only.
//
// This is the future single owner of licensing, registration limits, pricing,
// gateway, gst and platform fees. NOTHING consumes it yet (RD-PRICING-01C wires
// consumers behind the `pricingEngineEnabled` flag).

import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { FeeConfig } from '@/lib/fees/types'
import type { TaxBreakdown } from './tax'

// ─── Primitives ─────────────────────────────────────────────────────────────────

/** A registration cap. `null` = unlimited (Firestore cannot store Infinity). */
export type RegistrationLimit = number | null

/** The five platform pricing tiers. */
export type PricingTierId = 'free' | 'starter' | 'professional' | 'business' | 'enterprise'

export const PRICING_TIER_IDS: readonly PricingTierId[] = [
  'free', 'starter', 'professional', 'business', 'enterprise',
] as const

/** The only supported payment gateway today. */
export type GatewayProvider = 'razorpay'

// ─── Sections ───────────────────────────────────────────────────────────────────

/** One-time license price for a tier, in WHOLE RUPEES (₹). 0 = free. */
export interface TierPricing {
  regularPrice: number   // list price, ₹
  offerPrice:   number   // promotional price, ₹ (≤ regularPrice)
}

export interface TierDefinition {
  id:                PricingTierId
  label:             string
  registrationLimit: RegistrationLimit   // null = unlimited
  pricing:           TierPricing
}

/** licensing section — the tier catalog (limits + prices). */
export interface LicensingSettings {
  tiers: Record<PricingTierId, TierDefinition>
}

/** pricing section — platform-side charges. */
export interface PricingSettings {
  platformFeeAmount:  number   // FIXED platform fee in WHOLE RUPEES (₹), 0–99999 (NOT a percent)
  platformGstPercent: number   // 0–100 (GST on the platform fee)
}

/** gateway section — payment-gateway charges. */
export interface GatewaySettings {
  provider:           GatewayProvider
  gatewayPercent:     number   // 0–10
  gatewayGstPercent:  number   // 0–100 (GST on the gateway fee)
  convenienceFee:     number   // flat, ₹ (≥ 0)
}

/** features section — reserved, strongly-typed flags (no magic objects). */
export interface FeatureSettings {
  /**
   * Master switch for consumer migration (RD-PRICING-01C). While `false` (the
   * default), NO consumer reads this engine — the legacy resolvers stay
   * authoritative and behavior is unchanged. Flipping it `true` is what activates
   * the new engine for consumers.
   */
  pricingEngineEnabled: boolean
}

/** Who bears a given fee — mirrors the production FeeModel's payer axis. */
export type FeePayer = 'organizer' | 'attendee'

/**
 * RD-PRICING-02A — the configurable COMMERCIAL model. Each responsibility is modelled
 * INDEPENDENTLY (not a single `customer_pays`/`organizer_pays` enum) so the platform-
 * and gateway-fee payers, and the GST/convenience toggles, can be set per field. The
 * DEFAULT (defaults.ts) mirrors production exactly: organizer bears both fees, platform
 * GST on, gateway GST off, no convenience fee — i.e. production's `organizer_pays`.
 */
export interface CommercialModel {
  platformFeePaidBy:    FeePayer
  gatewayFeePaidBy:     FeePayer
  convenienceFeeEnabled: boolean
  gatewayGstEnabled:    boolean
  platformGstEnabled:   boolean
}

export interface PlatformSettingsMetadata {
  version:   number
  updatedAt: string | null   // ISO 8601; null in code defaults (never written)
  updatedBy: string | null   // admin uid; null in code defaults
}

/** The Firestore singleton `platformSettings/default`, and the resolved shape. */
export interface PlatformSettings {
  metadata:   PlatformSettingsMetadata
  licensing:  LicensingSettings
  pricing:    PricingSettings
  gateway:    GatewaySettings
  commercial: CommercialModel
  features:   FeatureSettings
}

// ─── Patch shape (PATCH /api/admin/platform-settings) ────────────────────────────
// A deep-partial of the editable sections. `metadata` is server-owned (never
// client-supplied). Each field is optional so a caller may update one value.

export interface TierPricingPatch { regularPrice?: number; offerPrice?: number }

export interface TierDefinitionPatch {
  label?:             string
  registrationLimit?: RegistrationLimit
  pricing?:           TierPricingPatch
}

export interface PlatformSettingsPatch {
  licensing?:  { tiers?: Partial<Record<PricingTierId, TierDefinitionPatch>> }
  pricing?:    Partial<PricingSettings>
  gateway?:    Partial<GatewaySettings>
  commercial?: Partial<CommercialModel>
  features?:   Partial<FeatureSettings>
}

// ─── RD-PRICING-01D — Override hierarchy & effective configuration ────────────────
//
// Precedence (highest → lowest): Admin Event Override → Organizer Event Override →
// Global Platform Settings → Production Defaults. Every configurable field resolves
// INDEPENDENTLY through this chain (never whole-object).

/** Where a resolved value came from, in precedence order (highest → lowest). */
export type ConfigurationSource = 'adminOverride' | 'organizerOverride' | 'global' | 'default'

/** A resolved value plus its provenance (powers the admin configuration trace). */
export interface TracedValue<T> {
  value:  T
  source: ConfigurationSource
}

/**
 * Per-event ADMIN override. Admin may override ANY configurable field (Phase 8).
 * Every field optional; an absent field falls through to the next precedence level.
 * Money is WHOLE RUPEES (₹); limits use RegistrationLimit (null = unlimited).
 */
export interface AdminEventOverride {
  registrationLimit?:  RegistrationLimit
  platformFeeAmount?:  number   // ₹ (fixed)
  platformGstPercent?: number
  gatewayPercent?:     number
  gatewayGstPercent?:  number
  convenienceFee?:     number   // ₹ (fixed)
  updatedAt?:          string | null   // ISO 8601
  updatedBy?:          string | null   // admin uid
}

/**
 * Per-event ORGANIZER override. Organizers may override ONLY this allow-list
 * (Phase 8): registration limit (DOWNWARD only — never above the licensed maximum)
 * and convenience fee. Branding is reserved for a future phase. The write API
 * enforces the allow-list + the downward rule; the resolver trusts validated data.
 */
export interface OrganizerEventOverride {
  registrationLimit?: number   // finite, ≤ licensed max (downward only)
  convenienceFee?:    number   // ₹ (fixed)
  updatedAt?:         string | null
  updatedBy?:         string | null   // organizer uid
}

/** Resolved, traced license view for an event (the licensed ceiling — no org override). */
export interface EffectiveLicense {
  tier:              EventLicenseTier
  maxRegistrations:  TracedValue<number>   // Infinity = unlimited (production shape)
  licensePricePaise: TracedValue<number>   // PAISE
}

/** Effective platform fee for an event: a FIXED amount in PAISE, plus its GST %. */
export interface EffectivePlatformFee {
  platformFeePaise:   number   // PAISE (via units.ts)
  platformGstPercent: number
}

/** Effective gateway charges for an event. */
export interface EffectiveGatewayCharges {
  gatewayPercent:      number
  gatewayGstPercent:   number
  convenienceFeePaise: number   // PAISE (via units.ts)
}

/**
 * The fully-resolved effective configuration for one event — every field carrying its
 * source (the admin debugging trace). Money is PAISE; limits are production shape
 * (Infinity = unlimited). `registrationLimit` is the EFFECTIVE cap (after overrides);
 * `license.maxRegistrations` is the licensed ceiling (no organizer override applied).
 */
export interface EffectivePlatformConfiguration {
  registrationLimit:    TracedValue<number>
  platformFeePaise:     TracedValue<number>
  platformGstPercent:   TracedValue<number>
  gatewayPercent:       TracedValue<number>
  gatewayGstPercent:    TracedValue<number>
  convenienceFeePaise:  TracedValue<number>
  license:              EffectiveLicense
  pricingEngineEnabled: boolean
}

/** The minimal event shape the effective-config resolvers read (tolerant of raw docs). */
export interface PricingEventView {
  license?:           { tier?: unknown } | null
  adminOverride?:     AdminEventOverride | null
  organizerOverride?: OrganizerEventOverride | null
}

// ─── RD-PRICING-01E-PREP — unified pricing summary ────────────────────────────────
//
// The single immutable pricing contract Payments / Wallet / Finance / Reports will
// consume (RD-PRICING-01E). Business modules never calculate pricing — they read this
// object. Money is carried in BOTH paise and rupees so consumers never convert.

export type CurrencyCode = 'INR'

/** A monetary amount in both units. `rupees` = `paise` / 100 (produced via units.ts). */
export interface Money { paise: number; rupees: number }

/** A monetary amount plus the precedence source it resolved from. */
export interface TracedMoney { paise: number; rupees: number; source: ConfigurationSource }

/** Provenance of the override-hierarchy values feeding a PricingSummary (Phase 5). */
export interface PricingSummaryTrace {
  registrationLimit: TracedValue<number>   // Infinity = unlimited
  convenienceFee:    TracedValue<number>   // paise
}

/**
 * RD-PRICING-02A — the reconciled fee breakdown, mirroring the production fee engine's
 * FeeCalculationResult (extended with gateway GST + convenience + attribution). All
 * paise. Under the DEFAULT commercial model this is field-for-field identical to
 * `calculateFee(feeModel: 'organizer_pays')`.
 */
export interface ReconciledFeeResult {
  grossAmountPaise:       number
  platformFeeBasePaise:   number
  platformFeeGstPaise:    number
  platformFeeTotalPaise:  number
  gatewayFeeBasePaise:    number
  gatewayFeeGstPaise:     number
  gatewayFeeTotalPaise:   number
  convenienceFeePaise:    number
  chargeAmountPaise:      number   // attendee pays / Razorpay order amount
  netSettlementPaise:     number   // organizer receives
  platformRevenuePaise:   number   // platform take (base + convenience; GST excluded)
  attendeeBearsPaise:     number
  organizerBearsPaise:    number
}

/** The licensed context the summary was priced under. */
export interface PricingSummaryLicense {
  tier:              EventLicenseTier
  registrationLimit: TracedValue<number>   // licensed ceiling (Infinity = unlimited)
  licensePrice:      TracedMoney            // one-time license price
}

/**
 * The immutable, fully-resolved pricing contract for ONE priced ticket. Treat as
 * immutable (Phase 8): to price different inputs, request a fresh summary — never
 * mutate this one. Every monetary field is present in paise AND rupees.
 */
export interface PricingSummary {
  // Versioning (Phase 4) — this snapshot is later stored on Orders.
  pricingVersion:       number   // the summary MODEL version (bump when the math changes)
  configurationVersion: number   // platformSettings metadata.version at resolution
  resolvedAt:           string   // ISO 8601
  currency:             CurrencyCode

  // Commercial policy + the exact fee structure this summary was priced under.
  commercial:   CommercialModel
  feeStructure: FeeConfig

  // Licensed context.
  license:           PricingSummaryLicense
  registrationLimit: TracedValue<number>   // effective cap (Infinity = unlimited)

  // Charges (reconciled fee engine — all Money in paise + rupees).
  ticketPrice:      Money
  platformFee:      Money   // base
  platformGst:      Money
  platformFeeTotal: Money   // base + gst
  gatewayProvider:  GatewayProvider
  gatewayFee:       Money   // base
  gatewayGst:       Money
  gatewayCost:      Money   // base + gst
  convenienceFee:   Money

  // Outcomes (model-agnostic invariants hold by construction).
  attendeePays:      Money   // charge / Razorpay order amount
  organizerReceives: Money   // net settlement
  platformRevenue:   Money

  /**
   * RD-PRODUCT-01E — the ORGANIZER's GST on the TICKET SALE (distinct from the platform-
   * fee GST above). Optional: absent on legacy summaries and whenever tax is disabled/
   * exempt, keeping this field backward compatible. When present it is computed once by
   * `computeTicketTax` and carried immutably into the Order Snapshot (checksum covers it).
   */
  tax?: TaxBreakdown

  trace: PricingSummaryTrace
}

// ─── RD-PRICING-01F — immutable order pricing snapshot ────────────────────────────
//
// The PERMANENT financial record stamped on an Order at creation. Once created, its
// pricing NEVER changes — later configuration changes must never affect historical
// orders (they read their own stored snapshot, never re-resolve). Extends the summary
// with an integrity checksum + an envelope version.

export interface OrderPricingSnapshot extends PricingSummary {
  /** Snapshot ENVELOPE version (distinct from pricingVersion / configurationVersion). */
  snapshotVersion: number
  /** SHA-256 (hex) over the canonical snapshot content, EXCLUDING this field. Integrity seal. */
  pricingChecksum: string
}

// ─── Validation result ───────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] }
