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
export const CURRENT_LICENSE_VERSION = 1

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

// ─── Guards & accessors ────────────────────────────────────────────────────────

export function isEventLicenseTier(v: unknown): v is EventLicenseTier {
  return typeof v === 'string' && (EVENT_LICENSE_TIERS as string[]).includes(v)
}

export function isEventLicenseStatus(v: unknown): v is EventLicenseStatus {
  return typeof v === 'string' && (EVENT_LICENSE_STATUSES as string[]).includes(v)
}

/**
 * Resolve a license definition for a tier at a given schema version. Falls back
 * to the current version's table when an unknown version is supplied so a future
 * event can never resolve to `undefined`.
 */
export function getEventLicenseDefinition(
  tier: EventLicenseTier,
  version: LicenseVersion = CURRENT_LICENSE_VERSION,
): EventLicenseDefinition {
  const table = EVENT_LICENSE_DEFINITIONS_BY_VERSION[version]
    ?? EVENT_LICENSE_DEFINITIONS_BY_VERSION[CURRENT_LICENSE_VERSION]
  return table[tier]
}

// The next tier up, for upgrade CTAs (enterprise has none).
export function nextEventLicenseTier(tier: EventLicenseTier): EventLicenseTier | null {
  const i = EVENT_LICENSE_TIERS.indexOf(tier)
  return i >= 0 && i < EVENT_LICENSE_TIERS.length - 1 ? EVENT_LICENSE_TIERS[i + 1] : null
}
