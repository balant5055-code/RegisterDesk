// RD-COMMS-CAPACITY-UX (L3) — refunded attendees and organizer broadcast audiences. Pure.
//
// A completed refund keeps the registration's `status: 'confirmed'` and sets
// `paymentStatus: 'refunded'` (lib/refunds/registrationRefunds — the authoritative record; the
// same field the check-in rule reads). So the "Confirmed Registrations" audience used to include
// people who were refunded — messaged as attendees and, on WhatsApp, charged a unit each.
//
//   'confirmed'  ⇒ refunded registrations are EXCLUDED (they are no longer confirmed attendees).
//                  A refund still pending (`refund_pending`) is not complete and stays included,
//                  exactly as at check-in.
//   'all'        ⇒ UNCHANGED: "All Registrations" is every registration of the event whatever its
//                  state (it already includes cancelled and rejected ones), as its label says.
//   'pending' / 'rejected' / 'cancelled' ⇒ unchanged (a refund does not move a registration
//                  into or out of those states).
//
// Shared by every audience builder (create route, job build, count preview) so they cannot drift.

import type { BroadcastAudience } from './types'

/** Whether this audience leaves refunded registrations out. */
export function audienceExcludesRefunded(audience: BroadcastAudience | string): boolean {
  return audience === 'confirmed'
}

/** The completed-refund state, read from the registration itself. */
export function isRefundedRegistration(reg: unknown): boolean {
  return (reg as { paymentStatus?: unknown } | null | undefined)?.paymentStatus === 'refunded'
}

/** Drop refunded registrations from a 'confirmed' audience; any other audience is returned as is. */
export function applyAudienceRefundRule<T extends { data: unknown }>(audience: BroadcastAudience | string, recipients: T[]): T[] {
  return audienceExcludesRefunded(audience) ? recipients.filter(r => !isRefundedRegistration(r.data)) : recipients
}
