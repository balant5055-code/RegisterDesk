// RD-ORGANIZER-01 P0-1 — the ONE canonical check-in eligibility rule.
//
// Every check-in entry point (QR scan, bulk, the canonical checkInRegistration helper)
// MUST consult this so admission rules can never diverge. Previously the QR scan route
// hand-rolled its own status checks and omitted `rejected`, so a rejected registration
// could be admitted at the gate while the bulk path (via checkInRegistration) blocked it.
//
// Returns the blocking reason, or null when the registration is admissible. The idempotent
// "already checked in" case is NOT a block (it is a success/no-op) and is handled by each
// caller. Pure — no I/O, safe to call inside or outside a transaction.
//
// Accepts a structural { status, paymentStatus } so every entry point can share it: the
// server RegistrationDocument (union types), the offline IndexedDB CachedAttendee (string
// fields), and any other cached shape. Only the two fields are read.

export type CheckInBlockReason = 'CANCELLED' | 'PENDING' | 'REJECTED' | 'REFUNDED'

export function checkInBlockReason(
  reg: { status: string; paymentStatus?: string | null },
): CheckInBlockReason | null {
  if (reg.status === 'cancelled')       return 'CANCELLED'
  if (reg.status === 'pending')         return 'PENDING'
  if (reg.status === 'rejected')        return 'REJECTED'
  if (reg.paymentStatus === 'refunded') return 'REFUNDED'
  return null
}
