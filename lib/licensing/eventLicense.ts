// Event License model — the frozen, SINGLE source of truth for RegisterDesk's
// per-event licensing architecture. This is the ONLY licensing system: there is no
// subscription model. Every price, registration limit, feature flag, and display
// feature matrix is defined here.
//
// All live consumers derive from this module: pricing/wizard/billing UI (via the
// definitions), capacity enforcement (lib/registrations/capacity), transaction fees
// (lib/billing/feeEngine), and workspace feature gating (lib/licensing/
// workspaceEntitlements — highest active event license).
//
// Client-safe: pure data + types, no server imports.

// ─── Tiers ──────────────────────────────────────────────────────────────────

export type EventLicenseTier = 'starter' | 'growth' | 'professional' | 'enterprise'

export const EVENT_LICENSE_TIERS: EventLicenseTier[] = [
  'starter', 'growth', 'professional', 'enterprise',
]

// Status of the license attached to an event. A paid tier is 'pending' until its
// one-time order is captured; Starter (free) activates immediately.
export type EventLicenseStatus = 'pending' | 'active'

export const EVENT_LICENSE_STATUSES: EventLicenseStatus[] = ['pending', 'active']

// ─── License version ──────────────────────────────────────────────────────────
//
// Every event license is stamped with the schema version it was issued under.
// Future pricing/feature changes ship as version 2+ and are added to the
// versioned definitions registry below; events already licensed under version 1
// keep resolving against the v1 table and never need migrating.
// RD-LICENSE-GA-04 — PRODUCTION CUTOVER. Flipped 1 → 2 after Waves 1–3 made every runtime,
// write, UI, admin, and coupon consumer version-aware. NEW licenses are now issued as
// Licensing V2 (free/starter/professional/business/enterprise, regular + offer prices).
// Historical version-1 licenses keep resolving through the frozen V1 table forever
// (V1_DEFINITIONS + EVENT_LICENSE_DEFINITIONS_BY_VERSION are untouched).
export const CURRENT_LICENSE_VERSION = 2

// A license schema version. A plain number so old (v1) and future (v2+) events
// coexist without type churn.
export type LicenseVersion = number

// ─── Feature flags & limits ────────────────────────────────────────────────────

// Boolean entitlements, resolved from an event's license tier.
export type EventLicenseFeature =
  | 'offlineCheckin'
  | 'teamAccess'
  | 'apiAccess'
  | 'whiteLabel'
  | 'customDomain'
  | 'advancedReports'
  | 'prioritySupport'

// Numeric limits, resolved from an event's license tier.
export type EventLicenseLimitKey =
  | 'maxRegistrations'
  | 'maxTeamMembers'
  | 'maxBroadcastRecipients'

// Sentinel for "no limit". A real JS number so comparisons (usage >= limit) just
// work; the UI renders it as "Unlimited".
export const UNLIMITED = Number.POSITIVE_INFINITY
export const isUnlimited = (n: number): boolean => !Number.isFinite(n)

// ─── Definitions ───────────────────────────────────────────────────────────────

export interface EventLicenseDefinition {
  tier:                   EventLicenseTier
  name:                   string
  licensePricePaise:      number   // one-time, per event. 0 = free
  contactSales:           boolean  // true ⇒ "Contact Sales" instead of a price
  transactionFeePercent:  number   // platform fee % on money the organizer collects
  transactionFeeCapPaise: number   // 0 = no cap
  limits:   Record<EventLicenseLimitKey, number>
  features: Record<EventLicenseFeature, boolean>
  // Display feature matrix — the ONE source of truth for the "Includes" bullets
  // rendered on every license surface (wizard cards, pricing page, review).
  // Ordered top-to-bottom; each higher tier begins with "Everything in <prev>".
  featureList: string[]
}

// The license record stamped/stored on an event — the reusable model that later
// phases persist to events/{slug}.license.
export interface EventLicense {
  tier:        EventLicenseTier
  status:      EventLicenseStatus
  version:     LicenseVersion
  // One-time purchase record. Absent/optional until a paid tier is captured.
  amountPaise?: number
  orderId?:     string | null
  paidAt?:      string | null   // ISO 8601
}

// ─── Version 1 definitions (FROZEN — Phase RD-LIC-01, production freeze) ──────
//
// ONE EVENT = ONE LICENSE. No subscriptions, no monthly plans. Each published
// event carries its own one-time Event License. This table is the single source
// of truth for price, registration limit, and the display feature matrix.
//
// Per-event pricing (final):
//   starter      — FREE,   100 registrations
//   growth       — ₹999,   1,000 registrations
//   professional — ₹2,499, 5,000 registrations
//   enterprise   — ₹4,999, unlimited registrations (self-serve, no contact-sales)
//
// Communication is never priced into a license: email is unlimited & free on every
// tier; WhatsApp/SMS are wallet-billed pay-as-you-go at send time.
//
// Transaction fees (stream 3, separate from the license fee):
//   starter 2.0% · growth 1.5% · professional 1.0% (cap ₹500) · enterprise 0.5% (cap ₹200)

const V1_DEFINITIONS: Record<EventLicenseTier, EventLicenseDefinition> = {
  starter: {
    tier: 'starter', name: 'Starter', licensePricePaise: 0, contactSales: false,
    transactionFeePercent: 2.0, transactionFeeCapPaise: 0,
    limits: {
      maxRegistrations:       100,
      maxTeamMembers:         1,
      maxBroadcastRecipients: 1_000,
    },
    features: {
      offlineCheckin: false, teamAccess: false, apiAccess: false, whiteLabel: false,
      customDomain: false, advancedReports: false, prioritySupport: false,
    },
    featureList: [
      'Unlimited email', 'QR tickets', 'Certificates', 'Coupons', 'Early bird pricing',
      'Multiple passes', 'Waitlist', 'Basic analytics', '1 team member',
    ],
  },
  growth: {
    tier: 'growth', name: 'Growth', licensePricePaise: 99_900, contactSales: false,
    transactionFeePercent: 1.5, transactionFeeCapPaise: 0,
    limits: {
      maxRegistrations:       1_000,
      maxTeamMembers:         3,
      maxBroadcastRecipients: 10_000,
    },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: false, whiteLabel: false,
      customDomain: false, advancedReports: false, prioritySupport: false,
    },
    featureList: [
      'Everything in Starter', 'CRM', 'Advanced analytics', '3 team members',
    ],
  },
  professional: {
    tier: 'professional', name: 'Professional', licensePricePaise: 249_900, contactSales: false,
    transactionFeePercent: 1.0, transactionFeeCapPaise: 50_000,
    limits: {
      maxRegistrations:       5_000,
      maxTeamMembers:         10,
      maxBroadcastRecipients: 50_000,
    },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: false, advancedReports: true, prioritySupport: true,
    },
    featureList: [
      'Everything in Growth', 'API access', 'Priority support', '10 team members',
    ],
  },
  enterprise: {
    tier: 'enterprise', name: 'Enterprise', licensePricePaise: 499_900, contactSales: false,
    transactionFeePercent: 0.5, transactionFeeCapPaise: 20_000,
    limits: {
      maxRegistrations:       UNLIMITED,
      maxTeamMembers:         UNLIMITED,
      maxBroadcastRecipients: UNLIMITED,
    },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: true, advancedReports: true, prioritySupport: true,
    },
    featureList: [
      'Everything in Professional', 'Unlimited team members', 'White label',
      'Custom domain', 'Dedicated support',
    ],
  },
}

// Versioned registry. Add a version 2 table here (never mutate version 1) when
// pricing/features change; events stamped v1 keep resolving against V1_DEFINITIONS.
export const EVENT_LICENSE_DEFINITIONS_BY_VERSION: Record<number, Record<EventLicenseTier, EventLicenseDefinition>> = {
  1: V1_DEFINITIONS,
}

export const DEFAULT_EVENT_LICENSE_TIER:   EventLicenseTier   = 'starter'
export const DEFAULT_EVENT_LICENSE_STATUS: EventLicenseStatus = 'pending'

// Tiers that are self-serve purchasable. Every paid tier — including Enterprise —
// uses the identical purchase flow (Razorpay order, wallet-first); there is no
// contact-sales or admin-approval path. Starter is free and needs no purchase.
export const PURCHASABLE_LICENSE_TIERS: EventLicenseTier[] = ['growth', 'professional', 'enterprise']

// ══════════════════════════════════════════════════════════════════════════════
// ─── Licensing V2 foundation (RD-LICENSE-01A) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// The APPROVED 5-tier business catalog, defined ALONGSIDE V1. This block is purely
// ADDITIVE: it introduces new types, a new definitions table, and new accessors, and
// modifies NOTHING above — every V1 type, table, default, guard, and accessor is left
// byte-for-byte unchanged.
//
// V2 is NOT the current version and has NO runtime consumer yet. CURRENT_LICENSE_VERSION
// stays 1, so new events still stamp/resolve V1 exactly as before; historical events keep
// resolving against V1. Wiring resolvers / config / UI to V2 is a LATER sprint (explicitly
// out of scope here). pricingEngineEnabled is untouched.
//
// Approved catalog (one-time, per event):
//   Free         200        ₹0     / ₹0
//   Starter      1,000      ₹1,299 / ₹999
//   Professional 2,500      ₹1,999 / ₹1,499
//   Business     5,000      ₹2,999 / ₹2,499
//   Enterprise   Unlimited  ₹9,999 / ₹7,999
//
// V2 tier VOCABULARY differs from V1 (free/professional/business are new; there is no
// `growth`), which is exactly why V2 needs its own type + table rather than an override.

export type EventLicenseTierV2 = 'free' | 'starter' | 'professional' | 'business' | 'enterprise'

export const EVENT_LICENSE_TIERS_V2: EventLicenseTierV2[] = [
  'free', 'starter', 'professional', 'business', 'enterprise',
]

/** The schema version V2 definitions are stamped under (V1 remains CURRENT_LICENSE_VERSION). */
export const LICENSE_VERSION_V2: LicenseVersion = 2

/**
 * A V2 license definition. Extends the V1 definition shape (same limits/features/featureList
 * contract, so a future consumer can read either uniformly) and adds the regular/offer split:
 *   • regularPricePaise — the list / strike-through price.
 *   • offerPricePaise   — the price actually charged; ALWAYS equals `licensePricePaise`
 *                         (kept in sync so any code reading `licensePricePaise` charges the
 *                         offer amount, exactly like V1).
 */
export interface EventLicenseDefinitionV2 extends Omit<EventLicenseDefinition, 'tier'> {
  tier:              EventLicenseTierV2
  regularPricePaise: number
  offerPricePaise:   number
}

// V2 definitions (FROZEN — the approved catalog). Non-price fields (team/broadcast limits,
// feature flags, transaction fees, feature bullets) are foundation defaults aligned by role
// with V1's progression; admin config may later override them. NONE of this is consumed yet.
const V2_DEFINITIONS: Record<EventLicenseTierV2, EventLicenseDefinitionV2> = {
  free: {
    tier: 'free', name: 'Free',
    licensePricePaise: 0, regularPricePaise: 0, offerPricePaise: 0,
    contactSales: false, transactionFeePercent: 2.0, transactionFeeCapPaise: 0,
    limits: { maxRegistrations: 200, maxTeamMembers: 1, maxBroadcastRecipients: 1_000 },
    features: {
      offlineCheckin: false, teamAccess: false, apiAccess: false, whiteLabel: false,
      customDomain: false, advancedReports: false, prioritySupport: false,
    },
    featureList: [
      'Unlimited email', 'QR tickets', 'Certificates', 'Coupons', 'Early bird pricing',
      'Multiple passes', 'Waitlist', 'Basic analytics', '1 team member',
    ],
  },
  starter: {
    tier: 'starter', name: 'Starter',
    licensePricePaise: 99_900, regularPricePaise: 129_900, offerPricePaise: 99_900,
    contactSales: false, transactionFeePercent: 1.5, transactionFeeCapPaise: 0,
    limits: { maxRegistrations: 1_000, maxTeamMembers: 3, maxBroadcastRecipients: 10_000 },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: false, whiteLabel: false,
      customDomain: false, advancedReports: false, prioritySupport: false,
    },
    featureList: [
      'Everything in Free', 'CRM', 'Advanced analytics', '3 team members',
    ],
  },
  professional: {
    tier: 'professional', name: 'Professional',
    licensePricePaise: 149_900, regularPricePaise: 199_900, offerPricePaise: 149_900,
    contactSales: false, transactionFeePercent: 1.0, transactionFeeCapPaise: 50_000,
    limits: { maxRegistrations: 2_500, maxTeamMembers: 5, maxBroadcastRecipients: 25_000 },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: false, advancedReports: false, prioritySupport: true,
    },
    featureList: [
      'Everything in Starter', 'API access', 'White label', 'Priority support', '5 team members',
    ],
  },
  business: {
    tier: 'business', name: 'Business',
    licensePricePaise: 249_900, regularPricePaise: 299_900, offerPricePaise: 249_900,
    contactSales: false, transactionFeePercent: 1.0, transactionFeeCapPaise: 50_000,
    limits: { maxRegistrations: 5_000, maxTeamMembers: 10, maxBroadcastRecipients: 50_000 },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: false, advancedReports: true, prioritySupport: true,
    },
    featureList: [
      'Everything in Professional', 'Advanced reports', '10 team members',
    ],
  },
  enterprise: {
    tier: 'enterprise', name: 'Enterprise',
    licensePricePaise: 799_900, regularPricePaise: 999_900, offerPricePaise: 799_900,
    contactSales: false, transactionFeePercent: 0.5, transactionFeeCapPaise: 20_000,
    limits: { maxRegistrations: UNLIMITED, maxTeamMembers: UNLIMITED, maxBroadcastRecipients: UNLIMITED },
    features: {
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: true, advancedReports: true, prioritySupport: true,
    },
    featureList: [
      'Everything in Business', 'Unlimited team members', 'Custom domain', 'Dedicated support',
    ],
  },
}

/** The V2 definitions table (frozen approved catalog). Read via getEventLicenseDefinitionV2. */
export const EVENT_LICENSE_DEFINITIONS_V2: Record<EventLicenseTierV2, EventLicenseDefinitionV2> = V2_DEFINITIONS

export const DEFAULT_EVENT_LICENSE_TIER_V2: EventLicenseTierV2 = 'free'

/** V2 tiers that are self-serve purchasable (paid, not contact-sales). */
export const PURCHASABLE_LICENSE_TIERS_V2: EventLicenseTierV2[] = ['starter', 'professional', 'business', 'enterprise']

export function isEventLicenseTierV2(v: unknown): v is EventLicenseTierV2 {
  return typeof v === 'string' && (EVENT_LICENSE_TIERS_V2 as string[]).includes(v)
}

/** Resolve a V2 license definition for a tier. Never undefined (the table is total). */
export function getEventLicenseDefinitionV2(tier: EventLicenseTierV2): EventLicenseDefinitionV2 {
  return EVENT_LICENSE_DEFINITIONS_V2[tier]
}

/** The next V2 tier up, for upgrade CTAs (enterprise has none). */
export function nextEventLicenseTierV2(tier: EventLicenseTierV2): EventLicenseTierV2 | null {
  const i = EVENT_LICENSE_TIERS_V2.indexOf(tier)
  return i >= 0 && i < EVENT_LICENSE_TIERS_V2.length - 1 ? EVENT_LICENSE_TIERS_V2[i + 1] : null
}

// ─── Guards & accessors ────────────────────────────────────────────────────────

export function isEventLicenseTier(v: unknown): v is EventLicenseTier {
  return typeof v === 'string' && (EVENT_LICENSE_TIERS as string[]).includes(v)
}

export function isEventLicenseStatus(v: unknown): v is EventLicenseStatus {
  return typeof v === 'string' && (EVENT_LICENSE_STATUSES as string[]).includes(v)
}

/**
 * Resolve a V1-vocabulary license definition for a tier at a given schema version.
 * `EVENT_LICENSE_DEFINITIONS_BY_VERSION` is the V1 registry (currently only version 1);
 * Licensing V2 is a SEPARATE vocabulary + table (getEventLicenseDefinitionV2), so this
 * accessor defaults to — and falls back to — V1 version 1 (NOT CURRENT_LICENSE_VERSION,
 * which after the GA-04 cutover points at V2). An unknown version can never resolve to
 * `undefined`.
 */
export function getEventLicenseDefinition(
  tier: EventLicenseTier,
  version: LicenseVersion = 1,
): EventLicenseDefinition {
  const table = EVENT_LICENSE_DEFINITIONS_BY_VERSION[version]
    ?? EVENT_LICENSE_DEFINITIONS_BY_VERSION[1]
  return table[tier]
}

// The next tier up, for upgrade CTAs (enterprise has none).
export function nextEventLicenseTier(tier: EventLicenseTier): EventLicenseTier | null {
  const i = EVENT_LICENSE_TIERS.indexOf(tier)
  return i >= 0 && i < EVENT_LICENSE_TIERS.length - 1 ? EVENT_LICENSE_TIERS[i + 1] : null
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── Version-aware resolution (RD-LICENSE-01B Phase 2 · foundation) ────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Infrastructure that resolves a license definition driven ONLY by the stored schema
// `version` — never inferred from the tier name. Historical events (version 1) resolve
// the V1 catalog; version-2 events resolve the V2 catalog. ADDITIVE: all V1/V2 tables,
// guards, and accessors above are unchanged, and no consumer calls this yet.

/**
 * The version-appropriate DEFAULT (free entry) tier for a NEW write under `version`:
 * version 1 → 'starter' (V1's free tier), version ≥2 → 'free' (V2's free tier). Write
 * paths use `defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)` so a fallback stamps
 * the correct free tier for whatever version is current. Identical to today at version 1.
 */
export function defaultLicenseTierForVersion(version: LicenseVersion): AnyEventLicenseTier {
  return version >= LICENSE_VERSION_V2 ? DEFAULT_EVENT_LICENSE_TIER_V2 : DEFAULT_EVENT_LICENSE_TIER
}

/**
 * The tier ids for the CURRENT license version — the vocabulary a WRITE-coupled admin
 * dialog (grant/upgrade/downgrade/entitlement override) must offer, so the chosen tier is
 * valid for CURRENT_LICENSE_VERSION. V1 today, V2 after the cutover. Pure, client-safe.
 */
export function currentLicenseTierIds(): AnyEventLicenseTier[] {
  return CURRENT_LICENSE_VERSION >= LICENSE_VERSION_V2 ? [...EVENT_LICENSE_TIERS_V2] : [...EVENT_LICENSE_TIERS]
}

/** Any tier from either version's vocabulary (V1 ∪ V2). `starter`/`professional`/
 *  `enterprise` are shared; `growth` is V1-only; `free`/`business` are V2-only. */
export type AnyEventLicenseTier = EventLicenseTier | EventLicenseTierV2

/**
 * True when `tier` is a valid tier FOR THE GIVEN schema version. Version-DRIVEN — the
 * version selects which vocabulary is legal; the tier name is never used to infer it.
 */
export function isValidTierForVersion(tier: unknown, version: LicenseVersion): tier is AnyEventLicenseTier {
  return version >= LICENSE_VERSION_V2 ? isEventLicenseTierV2(tier) : isEventLicenseTier(tier)
}

/**
 * A version-resolved license definition — the common shape every consumer reads. Superset
 * of both V1 and V2 defs: `regularPricePaise`/`offerPricePaise` are present ONLY for V2;
 * `licensePricePaise` is ALWAYS the charged price (on V2 it equals `offerPricePaise`), so
 * existing readers of `licensePricePaise` are correct on either version.
 */
export interface VersionedLicenseDefinition {
  version:                LicenseVersion
  tier:                   AnyEventLicenseTier
  name:                   string
  licensePricePaise:      number
  regularPricePaise?:     number
  offerPricePaise?:       number
  contactSales:           boolean
  transactionFeePercent:  number
  transactionFeeCapPaise: number
  limits:                 Record<EventLicenseLimitKey, number>
  features:               Record<EventLicenseFeature, boolean>
  featureList:            string[]
}

/**
 * Resolve a license definition driven ONLY by the stored `version`:
 *   version 1   → V1 catalog (starter · growth · professional · enterprise)
 *   version ≥ 2 → V2 catalog (free · starter · professional · business · enterprise)
 * Returns `null` when `tier` is not valid for that version — it NEVER falls back to
 * another version's table or silently mis-resolves (callers decide how to handle null).
 */
export function resolveVersionedLicenseDefinition(
  tier: string,
  version: LicenseVersion,
): VersionedLicenseDefinition | null {
  if (version >= LICENSE_VERSION_V2) {
    if (!isEventLicenseTierV2(tier)) return null
    return { version: LICENSE_VERSION_V2, ...getEventLicenseDefinitionV2(tier) }
  }
  if (!isEventLicenseTier(tier)) return null
  return { version: 1, ...getEventLicenseDefinition(tier, 1) }
}
