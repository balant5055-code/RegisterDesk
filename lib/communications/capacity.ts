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
//   • RD-WA-BLOCK-01 (2026-10-24): it NO LONGER funds a new WhatsApp message (see
//     legacyBalanceCanFundNewWhatsApp below) — capacity exhausted ⇒ the message is blocked. It
//     used to fund one at the configured legacy per-message price while it could pay the WHOLE
//     cost; what it already funded still settles (holds, charge-backs, refunds) unchanged;
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
 * RD-WA-BLOCK-01 — owner decision 2026-10-24: a NEW WhatsApp message is funded ONLY by the event's
 * prepaid WhatsApp capacity. When that capacity is exhausted the message is BLOCKED; the legacy
 * communication balance no longer funds new messages (it charged the legacy per-message price,
 * not the prepaid 20p + GST). Settlement of what the legacy balance ALREADY funded is unchanged —
 * a hold taken before this, a broadcast charge-back against an existing legacy charge, and refunds
 * into the balance all keep using `legacyBalanceCanFund` below.
 *
 * Every point that decides how a NEW message is paid for asks this, never `legacyBalanceCanFund`.
 */
export const LEGACY_BALANCE_FUNDS_NEW_WHATSAPP = false

export function legacyBalanceCanFundNewWhatsApp(balancePaise: number, costPaise: number): boolean {
  return LEGACY_BALANCE_FUNDS_NEW_WHATSAPP && legacyBalanceCanFund(balancePaise, costPaise)
}

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
