// RD-SA-COMMERCE-P1 · whether an event's licence lets it take NEW registrations — PURE, no I/O.
//
// The admin lifecycle (suspend / cancel) and a licence refund used to change nothing a buyer could
// feel: the registration transaction never read the licence, so a refunded or cancelled event kept
// selling. Every transaction that ADDS a committed seat (create, settle a captured payment, restore,
// approve) now reads `eventLicenses/{slug}` inside the transaction and refuses when this returns a
// state. Because every licence action that sets one of these states writes the licence document in
// its own transaction, a concurrent registration either commits first (and is counted) or conflicts
// and re-reads the new state — never both.
//
// Existing registrations, payments and history are untouched: this only refuses NEW seats.
// An event with no licence document (free / legacy) is never blocked here.

export type LicenceBlockState = 'refund_in_progress' | 'refunded' | 'suspended' | 'cancelled'

/** The refusal reason every seat-adding path reports for a blocked licence. */
export const LICENCE_INACTIVE = 'LICENCE_INACTIVE' as const

export function licenceRegistrationBlock(data: unknown): LicenceBlockState | null {
  if (!data || typeof data !== 'object') return null
  const d = data as {
    refundHold?: unknown; refundedAt?: unknown; entitlementRestoredAt?: unknown
    admin?: { lifecycle?: unknown } | null
  }
  // A refund has claimed the licence and is moving money: nothing may be sold meanwhile.
  if (d.refundHold != null) return 'refund_in_progress'
  // Refunded ⇒ blocked until a Super Admin explicitly restores the entitlement (audited).
  if (d.refundedAt != null && d.entitlementRestoredAt == null) return 'refunded'
  const lifecycle = d.admin?.lifecycle
  if (lifecycle === 'suspended') return 'suspended'
  if (lifecycle === 'cancelled') return 'cancelled'
  return null
}
