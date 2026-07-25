// RD-PRODUCT-01F — Post-publish edit field classification. PURE, single source of truth.
//
// Classifies every field an organizer might submit when editing a LIVE event into:
//   • safe       — freely editable post-publish (content: banner, description, speakers…)
//   • restricted — identity/commercial fields frozen after publish (eventType, currency,
//                  pricing model, license, slug…). Changing these would break historical
//                  integrity, so they are rejected on the edit path.
//   • locked     — never touched by ANY edit; belong to immutable financial / attendee
//                  records that live in SEPARATE collections (orders, snapshots, payments,
//                  registrations, ticket/QR IDs, coupons, certificates, wallet, finance).
//
// The edit route already restricts by OMISSION; this module adds explicit, enforceable
// classification (defense-in-depth) and drives the "notify registered attendees" gate.
// It is pure so it can be unit-tested and imported anywhere (client or server).

export type EditClassification = 'safe' | 'restricted' | 'locked' | 'unknown'

// ─── SAFE — the editable content set (mirrors EventEditPayload) ─────────────────────

export const SAFE_EDIT_KEYS: readonly string[] = [
  'name', 'tagline', 'shortDesc', 'fullDesc', 'bannerUrl', 'logoUrl',
  'startDate', 'startTime', 'endDate', 'endTime', 'timezone',
  'venueType', 'venueName', 'venueCity', 'venueAddress', 'venueState',
  'venueCountry', 'venuePincode', 'venueMapsLink', 'onlinePlatform', 'onlineMeetingUrl',
  'organizerName', 'organizerEmail', 'organizerPhone', 'organizerWebsite',
  'speakers', 'sponsors', 'galleryImages',
  'metaTitle', 'metaDescription', 'keywords',
  'passCapacityUpdates',
] as const

/**
 * ATTENDEE-IMPACTFUL safe fields — editable, but a change materially affects people who
 * already registered (where/when the event happens). Editing any of these REQUIRES the
 * organizer to be offered "Notify Registered Attendees" (Phase 3). Matches the impactful
 * set the edit route already detects.
 */
export const IMPACTFUL_EDIT_KEYS: readonly string[] = [
  'startDate', 'startTime', 'endDate', 'endTime',
  'venueType', 'venueName', 'venueCity', 'venueAddress',
  'onlinePlatform', 'onlineMeetingUrl',
] as const

// ─── RESTRICTED — identity/commercial fields frozen after publish ──────────────────

export const RESTRICTED_EDIT_KEYS: readonly string[] = [
  'eventType', 'eventSubtype', 'campaignType', 'visibility', 'currency',
  'organizer', 'organizerUid', 'uid', 'registrationMode', 'pricingModel',
  'license', 'licenseTier', 'tier', 'planType', 'passPrice', 'passPrices',
  'price', 'prices', 'urlSlug', 'slug',
] as const

// ─── LOCKED — immutable records, never mutated by an edit ───────────────────────────
// These name the financial/attendee domains that live in separate collections. Any key
// containing one of these tokens is rejected outright.

export const LOCKED_DOMAINS: readonly string[] = [
  'order', 'orders', 'orderSnapshot', 'pricingSnapshot', 'snapshot', 'transaction',
  'transactions', 'payment', 'payments', 'registration', 'registrations', 'ticketId',
  'ticketIds', 'qr', 'qrId', 'qrIds', 'coupon', 'coupons', 'redemption', 'redemptions',
  'certificate', 'certificates', 'wallet', 'finance', 'financial', 'settlement', 'ledger',
] as const

const SAFE_SET       = new Set(SAFE_EDIT_KEYS)
const IMPACTFUL_SET  = new Set(IMPACTFUL_EDIT_KEYS)
const RESTRICTED_SET = new Set(RESTRICTED_EDIT_KEYS)
const LOCKED_SET     = new Set(LOCKED_DOMAINS.map(t => t.toLowerCase()))

// ─── Classification ─────────────────────────────────────────────────────────────────

/** Classify a single submitted key. Unknown keys are treated conservatively (rejected). */
export function classifyEditKey(key: string): EditClassification {
  if (SAFE_SET.has(key)) return 'safe'
  const lower = key.toLowerCase()
  // Locked wins over restricted (a "couponPrice" is locked, not merely restricted).
  for (const token of LOCKED_SET) { if (lower.includes(token)) return 'locked' }
  if (RESTRICTED_SET.has(key)) return 'restricted'
  return 'unknown'
}

export interface EditKeyPartition {
  safe:       string[]
  restricted: string[]
  locked:     string[]
  unknown:    string[]
}

/** Partition submitted keys by classification (drops the reserved metadata key `reason`). */
export function partitionEditKeys(keys: string[]): EditKeyPartition {
  const out: EditKeyPartition = { safe: [], restricted: [], locked: [], unknown: [] }
  for (const key of keys) {
    if (key === 'reason') continue   // metadata, not a field edit
    out[classifyEditKey(key)].push(key)
  }
  return out
}

/**
 * Enforce the classification on a raw edit body. Returns the keys that must be rejected
 * (locked + restricted + unknown). An empty array means every submitted key is safe.
 */
export function findForbiddenEditKeys(keys: string[]): string[] {
  const p = partitionEditKeys(keys)
  return [...p.locked, ...p.restricted, ...p.unknown]
}

/** True when any changed field is attendee-impactful → attendee notification is required. */
export function requiresAttendeeNotification(changedKeys: string[]): boolean {
  return changedKeys.some(k => IMPACTFUL_SET.has(k))
}

/** The subset of changed keys that are attendee-impactful. */
export function impactfulSubset(changedKeys: string[]): string[] {
  return changedKeys.filter(k => IMPACTFUL_SET.has(k))
}
