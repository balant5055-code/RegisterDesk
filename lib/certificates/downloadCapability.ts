// Short-lived download capability for the Event Day Certificate Center.
//
// ═══ WHY A NEW TOKEN AND NOT THE EXISTING ONE ════════════════════════════════
// A certificate already has `verificationToken` — a PERMANENT capability minted at
// generation and emailed to the attendee. The Certificate Center identifies people by
// email or registration id, which are guessable, so handing back the permanent token
// would turn a lookup into indefinite access to that certificate for anyone who guessed.
//
// This token is deliberately weaker: it names ONE certificate, inside ONE event, for the
// single purpose of downloading, and it expires. `verificationToken` is never returned by
// the lookup API and `download.requireVerification` is never bypassed — the file route
// accepts this as an ADDITIONAL credential, not as a way around the existing check.
//
// ═══ CONSTRUCTION ════════════════════════════════════════════════════════════
// Follows the repo's established pattern (lib/receipts/token.ts, lib/tickets/generate.ts):
// HMAC-SHA256 over TICKET_SECRET with a purpose-specific PREFIX, so a token minted here
// can never be replayed as a ticket or receipt token. The expiry travels WITH the token
// and is inside the signed message, so it cannot be edited by the holder.

import crypto from 'crypto'
import { TICKET_SECRET } from '@/lib/env'

/** Long enough to walk from the QR poster to a quiet spot; short enough that a leaked
 *  link in a shared browser or a screenshot is worthless by the time it travels. */
export const CAPABILITY_TTL_MS = 15 * 60 * 1000

const PREFIX  = 'certdl:'
const HEX_64  = /^[0-9a-f]{64}$/
/** `<expiryMillis>.<hex signature>` */
const TOKEN_RE = /^(\d{10,16})\.([0-9a-f]{64})$/

/** The signed message. Binds certificate + event + purpose + expiry, so a token for one
 *  certificate cannot be replayed against another, nor against the same certificate id
 *  reached through a different event. */
function message(certificateId: string, eventSlug: string, expiresAt: number): string {
  return `${PREFIX}${eventSlug}:${certificateId}:${expiresAt}`
}

function sign(certificateId: string, eventSlug: string, expiresAt: number): string {
  return crypto.createHmac('sha256', TICKET_SECRET)
    .update(message(certificateId, eventSlug, expiresAt))
    .digest('hex')
}

/** Mint a capability. `now` is injectable so tests do not depend on wall-clock timing. */
export function signCertificateDownloadCapability(
  certificateId: string,
  eventSlug:     string,
  now:           number = Date.now(),
): string {
  const expiresAt = now + CAPABILITY_TTL_MS
  return `${expiresAt}.${sign(certificateId, eventSlug, expiresAt)}`
}

/**
 * Verify a capability for exactly this certificate in exactly this event.
 *
 * Expiry is checked BEFORE the HMAC comparison only to avoid pointless work; the
 * comparison itself is timing-safe. A malformed token is rejected outright rather than
 * being fed to Buffer.from, which would otherwise silently truncate garbage into a
 * comparable buffer.
 */
export function verifyCertificateDownloadCapability(
  certificateId: string,
  eventSlug:     string,
  token:         string,
  now:           number = Date.now(),
): boolean {
  const m = TOKEN_RE.exec((token ?? '').trim())
  if (!m) return false

  const expiresAt = Number(m[1])
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false

  const expected = Buffer.from(sign(certificateId, eventSlug, expiresAt), 'hex')
  const actual   = Buffer.from(m[2], 'hex')
  if (expected.length !== actual.length) return false
  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/** True when the string is shaped like a capability at all — lets the file route tell a
 *  capability apart from the permanent verificationToken without trying both. */
export function looksLikeDownloadCapability(token: string): boolean {
  return TOKEN_RE.test((token ?? '').trim()) && !HEX_64.test((token ?? '').trim())
}
