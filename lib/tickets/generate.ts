// Server-only: ticket generation utilities.
// No SDK dependencies — safe to test in isolation.

import crypto from 'crypto'

// ─── QR value ─────────────────────────────────────────────────────────────────

/**
 * Builds the QR payload string stored on the registration and encoded into
 * the QR image.  Never trust the scanned payload itself — always re-load the
 * registration from Firestore using the registrationId component.
 *
 * Format: RD:{eventSlug}:{registrationId}:{ticketCode}
 */
export function buildQrValue(
  eventSlug:      string,
  registrationId: string,
  ticketCode:     string,
): string {
  return `RD:${eventSlug}:${registrationId}:${ticketCode}`
}

/**
 * Parses a scanned QR payload.  Returns null when the format is unrecognised
 * so callers can reject tampered codes without crashing.
 */
export function parseQrValue(raw: string): {
  eventSlug:      string
  registrationId: string
  ticketCode:     string
} | null {
  const parts = raw.split(':')
  if (parts.length !== 4 || parts[0] !== 'RD') return null
  const [, eventSlug, registrationId, ticketCode] = parts
  if (!eventSlug || !registrationId || !ticketCode) return null
  return { eventSlug, registrationId, ticketCode }
}

// ─── Ticket download token ─────────────────────────────────────────────────────
//
// Short-lived capability token for the PDF download link.  We use an HMAC rather
// than a bare UUID so:
//  1. Even if a registrationId leaks (logs, analytics, URL sharing), the PDF
//     cannot be downloaded without server knowledge of TICKET_SECRET.
//  2. The token is stateless — no DB round-trip needed for verification.
//
// Set TICKET_SECRET to any random 32+ byte hex or base64 string in .env.local
// and in your deployment secrets.  If the variable is absent the functions
// degrade gracefully (sign returns null; verify returns false).

const TICKET_SECRET = process.env.TICKET_SECRET

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Returns the HMAC-SHA256 hex digest that authorises PDF download for this
 * registrationId.  Returns null when TICKET_SECRET is not configured.
 */
export function signTicketToken(registrationId: string): string | null {
  if (!TICKET_SECRET) return null
  return crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(registrationId)
    .digest('hex')
}

/**
 * Timing-safe verification of a ticket download token.
 * Returns false if TICKET_SECRET is not configured or the token is malformed.
 */
export function verifyTicketToken(registrationId: string, token: string): boolean {
  if (!TICKET_SECRET) return false
  if (!HEX_64.test(token)) return false

  const expected = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(registrationId)
    .digest()

  const actual = Buffer.from(token, 'hex')  // always 32 bytes after regex check

  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
