// RD-COMMS-P1 · Communication capacity — the ONE rule for what may fund a WhatsApp message or a
// certificate, and the organizer-facing wording for "you need more capacity". Isomorphic (no
// server imports) so the UI and the server say exactly the same thing.
//
// ═══ THE MODEL ═══════════════════════════════════════════════════════════════
// Communication capacity is bought ONLY on the event's License & Services step and lives in that
// event's allowance ledger (eventServiceAllowances/{draftId}). It is the current entitlement.
//
// The organizer "communication balance" (organizerWallets/{uid}) is LEGACY, in CONTROLLED DRAIN:
//   • nothing can add new money to it — the top-up route is retired (410). Its only remaining
//     inflows settle money that was already paid before retirement (a top-up order created
//     before it, a broadcast refund of a legacy charge, a legacy licence refund), so EVERY paise
//     in it is legacy by construction — no per-paise "is this legacy?" marker is needed;
//   • it may still fund a WhatsApp message the event's allowance does not cover, at the
//     configured legacy per-message price, while it can pay the WHOLE cost — never going below
//     zero, never as credit;
//   • it never funds a certificate (certificates require certificate capacity);
//   • once it cannot cover a message, the message is BLOCKED and the organizer is sent to
//     License & Services. There is no other pay-as-you-go path.
//
// An allowance's stored `onExhausted: 'wallet_payg'` is honoured only through this same rule
// (it no longer creates a NEW pay-as-you-go charge): exhausted ⇒ legacy drain, else block.

/** Where more communication capacity is bought. */
export const LICENSE_SERVICES_CTA = 'Manage in License & Services'

export const WHATSAPP_CAPACITY_REQUIRED =
  'WhatsApp capacity is required for this message. Purchase communication capacity in License & Services.'
export const WHATSAPP_BROADCAST_CAPACITY_REQUIRED =
  'WhatsApp capacity is required for this broadcast. Purchase communication capacity in License & Services.'
export const CERTIFICATE_CAPACITY_REQUIRED =
  'Certificate capacity is required. Purchase certificate capacity in License & Services.'

/**
 * Pure. May the organizer's LEGACY communication balance fund a send the event's allowance does
 * not cover? Only when there is a real legacy price to charge and the balance covers ALL of it —
 * the drain never runs the balance below zero (an allow-negative setting is NOT honoured here:
 * a negative balance would be new credit, i.e. a new pay-as-you-go model).
 */
export function legacyBalanceCanFund(balancePaise: number, costPaise: number): boolean {
  return Number.isFinite(costPaise) && costPaise > 0
    && Number.isFinite(balancePaise) && balancePaise >= costPaise
}
