// RD-EVENT-COMMERCE-05F — the organizer's PUBLISH AGREEMENT, validated on the server. PURE.
//
// The wizard's final step (License & Services) has always shown this agreement — four explicit
// items, none pre-checked — but the consent never left the browser: the publish route and the
// draft purchase route (which creates the Razorpay order) accepted any request. This module is
// the server half. It adds NO legal wording: the items are the existing wizard statements, and the
// documents are the existing /terms ("Terms of Service") and /privacy ("Privacy Policy") pages.
//
// There is no organizer terms VERSION anywhere in the codebase (PLATFORM_TERMS_VERSION in
// ./platformTerms is the PARTICIPANT terms), so none is recorded — nothing is invented.

/** The existing statements, keyed. `settlementFeePolicy` exists only for a PAID event. */
export const PUBLISH_AGREEMENT_ITEMS = ['accurateInformation', 'settlementFeePolicy', 'termsOfService', 'privacyPolicy'] as const
export type PublishAgreementItem = typeof PUBLISH_AGREEMENT_ITEMS[number]

/** What the browser sends: one explicit `true` per item the organizer ticked. */
export type PublishAgreementInput = Partial<Record<PublishAgreementItem, boolean>>

/** The approved documents the agreement links to (existing public pages). */
export const PUBLISH_AGREEMENT_DOCUMENTS = { termsOfService: '/terms', privacyPolicy: '/privacy' } as const

export const AGREEMENT_REQUIRED_MESSAGE =
  'Please accept the Publish Agreement on License & Services before publishing. Nothing was charged or published.'

/** Paid ⇔ not explicitly free — the SAME rule the wizard uses (`pricing.eventType === 'free'`). */
export function isPaidEventPricing(pricing: unknown): boolean {
  return !(pricing && typeof pricing === 'object' && (pricing as Record<string, unknown>).eventType === 'free')
}

export type PublishAgreementCheck =
  | { ok: true;  items: Partial<Record<PublishAgreementItem, true>> }
  | { ok: false; missing: PublishAgreementItem[] }

/**
 * Every item required for this event must be the literal boolean `true`. A missing agreement,
 * a missing item, `"true"`, `1` or any other value is refused — consent is never inferred.
 * Items that do not apply (the fee policy on a free event) are ignored, not recorded.
 */
export function checkPublishAgreement(raw: unknown, opts: { paidEvent: boolean }): PublishAgreementCheck {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const required = PUBLISH_AGREEMENT_ITEMS.filter(k => k !== 'settlementFeePolicy' || opts.paidEvent)
  const missing = required.filter(k => a[k] !== true)
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, items: Object.fromEntries(required.map(k => [k, true])) as Partial<Record<PublishAgreementItem, true>> }
}
