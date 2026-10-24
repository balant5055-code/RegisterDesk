// RD-COUPON-SWITCH-01 · whether EVENT coupons may be redeemed — server only.
//
// Two switches, both enforced here and nowhere else:
//   • the PLATFORM switch (Business Configuration feature flag `coupons`), which used to be checked
//     only by the public /validate-coupon preview — checkout (/create-order, /submit) and the fee
//     preview called validateCoupon directly and so redeemed codes while it was off;
//   • a per-EVENT switch a Super Admin sets (owner decision 2026-10-24: Super Admin only), stored
//     in `eventAdminControls/{slug}` — a server-only document (Firestore rules deny clients by
//     default), separate from events/{slug} so a publish / republish rewriting the event can never
//     silently drop it.
//
// validateCoupon (lib/coupons/validate.ts) asks couponsAllowedForEvent before anything else, so every
// path that applies a code — preview, fee preview, paid checkout, free-via-coupon submit — is gated.
// Orders already created keep their price: settlement prices from the payment intent's frozen
// snapshot, never by re-validating the code.

import { adminDb } from '@/lib/firebase/admin'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'

export const EVENT_ADMIN_CONTROLS = 'eventAdminControls'

export interface EventCouponSwitch {
  /** True when a Super Admin switched coupons OFF for this event. */
  disabled:   boolean
  updatedBy:  string | null
  updatedAt:  string | null
  reason:     string | null
}

const iso = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

/** The event's switch as stored (absent document ⇒ coupons not disabled for the event). */
export async function getEventCouponSwitch(eventSlug: string): Promise<EventCouponSwitch> {
  const snap = await adminDb.collection(EVENT_ADMIN_CONTROLS).doc(eventSlug).get()
  const d = (snap.exists ? snap.data() : {}) as { couponsDisabled?: unknown; couponsUpdatedBy?: unknown; couponsUpdatedAt?: unknown; couponsReason?: unknown }
  return {
    disabled:  d.couponsDisabled === true,
    updatedBy: typeof d.couponsUpdatedBy === 'string' ? d.couponsUpdatedBy : null,
    updatedAt: iso(d.couponsUpdatedAt),
    reason:    typeof d.couponsReason === 'string' ? d.couponsReason : null,
  }
}

export const COUPONS_OFF_PLATFORM = 'Coupons are not available right now.'
export const COUPONS_OFF_EVENT    = 'Coupons are not available for this event.'

/**
 * May a coupon code be redeemed for this event right now? FAIL-CLOSED for the coupon only: if either
 * switch cannot be read, the code is refused (the attendee can still register at the full price);
 * a read failure never applies a discount that may have been switched off.
 */
export async function couponsAllowedForEvent(eventSlug: string): Promise<{ ok: true } | { ok: false; error: string; scope: 'platform' | 'event' }> {
  try {
    const [flags, ev] = await Promise.all([getFeatureFlags(), getEventCouponSwitch(eventSlug)])
    if (!flags.coupons) return { ok: false, error: COUPONS_OFF_PLATFORM, scope: 'platform' }
    if (ev.disabled)    return { ok: false, error: COUPONS_OFF_EVENT, scope: 'event' }
    return { ok: true }
  } catch {
    return { ok: false, error: COUPONS_OFF_PLATFORM, scope: 'platform' }
  }
}
