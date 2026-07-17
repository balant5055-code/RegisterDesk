// HMAC token for one-click unsubscribe links embedded in broadcast emails.
//
// Token covers both email + organizerUid so:
//   - Recipients cannot forge tokens for other emails.
//   - Tokens cannot be replayed across organizers.
//
// Uses the same TICKET_SECRET as ticket/receipt tokens (different prefix
// ensures tokens cannot be cross-used between purposes).
//
// URL shape produced by buildUnsubscribeUrl():
//   {APP_URL}/unsubscribe?email=<encoded>&org=<uid>&token=<hex64>

import crypto from 'crypto'
import { TICKET_SECRET, APP_URL } from '@/lib/env'

const HEX_64 = /^[0-9a-f]{64}$/
const PREFIX  = 'unsubscribe:'

// Payload encodes both email and organizerUid — changing either invalidates the token.
function tokenPayload(email: string, organizerUid: string): string {
  return `${PREFIX}${email.toLowerCase().trim()}:${organizerUid}`
}

export function signUnsubscribeToken(email: string, organizerUid: string): string {
  return crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(tokenPayload(email, organizerUid))
    .digest('hex')
}

export function verifyUnsubscribeToken(
  email:        string,
  organizerUid: string,
  token:        string,
): boolean {
  if (!HEX_64.test(token)) return false
  const expected = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(tokenPayload(email, organizerUid))
    .digest()
  const actual = Buffer.from(token, 'hex')
  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

// Convenience: build the full unsubscribe URL for embedding in emails.
export function buildUnsubscribeUrl(
  email:        string,
  organizerUid: string,
): string {
  const token = signUnsubscribeToken(email, organizerUid)
  return (
    `${APP_URL}/unsubscribe` +
    `?email=${encodeURIComponent(email)}` +
    `&org=${encodeURIComponent(organizerUid)}` +
    `&token=${token}`
  )
}

// One-click endpoint URL for the List-Unsubscribe header (RFC 8058). Same signed
// token as the body link; the /api/unsubscribe route accepts a POST (one-click)
// and redirects a GET to the existing /unsubscribe confirmation page.
export function buildUnsubscribeApiUrl(
  email:        string,
  organizerUid: string,
): string {
  const token = signUnsubscribeToken(email, organizerUid)
  return (
    `${APP_URL}/api/unsubscribe` +
    `?email=${encodeURIComponent(email)}` +
    `&org=${encodeURIComponent(organizerUid)}` +
    `&token=${token}`
  )
}
