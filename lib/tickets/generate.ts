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
// HMAC-SHA256 capability token for PDF download links.
// TICKET_SECRET is required at runtime — validated once at startup by lib/env.ts.

import { TICKET_SECRET } from '@/lib/env'

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Returns the HMAC-SHA256 hex digest that authorises PDF download for this
 * registrationId.  TICKET_SECRET is guaranteed non-empty by the startup guard above.
 */
export function signTicketToken(registrationId: string): string {
  return crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(registrationId)
    .digest('hex')
}

/**
 * Timing-safe verification of a ticket download token.
 * Returns false if the token is malformed or the HMAC does not match.
 */
export function verifyTicketToken(registrationId: string, token: string): boolean {
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
