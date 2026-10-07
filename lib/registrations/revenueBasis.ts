// RD-FIN-02 · B5 — THE per-registration "Ticket revenue" basis.
//
// What each money figure means (canonical, from the ledger model — lib/payments/registrationLedger.ts,
// lib/fees/types.ts, docs/RD-DASHBOARD-09-FINANCE-SOURCE.md):
//   amount            = the ATTENDEE CHARGE (what the gateway captured) = ticket base + attendee-borne fees
//   ticket base       = the pass price after coupon — ORGANIZER revenue before platform fees
//   attendeeFeePaise  = attendee-borne fees inside `amount` (only under attendee-pays; ABSENT ⇒ 0)
//   Ticket revenue    = Σ ticket base over CONFIRMED registrations (registrationCounters.revenuePaise)
//   Attendee paid     = Σ amount (the charge) — a different figure, kept on `amount` deliberately
//
// Settlement used to add the ticket base while cancel / restore / approve / reconciliation /
// analytics all used the gross `amount`. Identical while attendee-pays is OFF; divergent the moment it
// is ON. Every path now reads the basis through these two functions. The fee is stored on the
// registration ONLY when > 0, so legacy and organizer-pays documents are unchanged and need no backfill.

export const ATTENDEE_FEE_FIELD = 'attendeeFeePaise' as const

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

/** Ticket-revenue basis of a stored registration: amount − attendee fee (never negative). */
export function registrationRevenueBasisPaise(reg: { amount?: unknown; attendeeFeePaise?: unknown }): number {
  return Math.max(0, Math.max(0, int(reg.amount)) - Math.max(0, int(reg.attendeeFeePaise)))
}

/** Settlement-side basis: the intent's ticket base, never above the charge (so cancel reverses exactly what settle added). */
export function settlementRevenueBasisPaise(intent: { amount: number; financials?: { ticketBasePaise?: number } | null }): number {
  const b = intent.financials?.ticketBasePaise
  return typeof b === 'number' && Number.isFinite(b) ? Math.max(0, Math.min(intent.amount, Math.trunc(b))) : intent.amount
}
