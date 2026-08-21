// RD-CHECKIN-STAFF-01 — the ONE ticket-QR parser.
//
// Extracted verbatim from the dashboard check-in client so the new gate surface at
// /ops/checkin/[eventId] reuses it instead of growing a second copy. Behaviour is
// unchanged; this file only gives the rule one home.
//
// ═══ WHY ONLY THE TICKET CODE IS TAKEN ═══════════════════════════════════════
// A ticket QR carries FOUR fields, and three of them are attacker-supplied the
// moment someone prints their own QR:
//
//     RD:{eventSlug}:{registrationId}:{ticketCode}
//
// Only `ticketCode` is returned. The server re-resolves the registration from that
// code and re-derives the event and owner from the stored document, so a forged
// `registrationId` or `eventSlug` in the payload changes nothing about which
// registration is checked in. Returning the whole tuple would invite a caller to
// start trusting parts of it — which is exactly the bug this shape prevents.
//
// PURE — no DOM, no network — so the rule is unit-testable without a browser.

/** The QR envelope: a literal "RD" tag followed by three colon-separated fields. */
const QR_PARTS = 4
const QR_TAG   = 'RD'

/**
 * The ticket code carried by a scanned QR payload, or a manually typed code.
 *
 * Accepts both because the gate accepts both: a camera yields the full envelope,
 * a keyboard yields a bare code (`RD-XXXXXXXX`). Anything that is not a
 * well-formed envelope is passed through untouched and validated server-side —
 * this function's job is to unwrap, never to authorize.
 *
 * Normalised to upper case and trimmed, matching what the scan endpoint expects.
 */
export function ticketCodeFromQr(raw: string): string {
  const value = (raw ?? '').trim()
  const parts = value.split(':')
  const code  = parts.length === QR_PARTS && parts[0] === QR_TAG ? parts[3] : value
  return code.trim().toUpperCase()
}
