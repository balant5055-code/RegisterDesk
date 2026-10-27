// RD-RESEND-WEBHOOK · Svix signature verification for the Resend webhook (no SDK). SERVER-ONLY.
// Signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 keyed with the base64
// secret (after the "whsec_" prefix), compared timing-safe against each "v1,<sig>" entry; and the
// timestamp must be within Svix's tolerance so a captured message cannot be replayed later.

import crypto from 'crypto'

/** RD-RESEND-WEBHOOK — Svix's replay window: a signed message older/newer than this is refused. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60

export function verifySvix(rawBody: string, headers: Headers, secret: string, nowMs = Date.now()): boolean {
  const id   = headers.get('svix-id')
  const ts   = headers.get('svix-timestamp')
  const sigs = headers.get('svix-signature')
  if (!id || !ts || !sigs) return false
  // A valid signature on an OLD message is a replay (e.g. a captured bounce resent to suppress an
  // address): the timestamp is part of the signed content, so checking its age closes that.
  const tsSec = Number(ts)
  if (!Number.isFinite(tsSec) || Math.abs(nowMs / 1000 - tsSec) > SVIX_TOLERANCE_SECONDS) return false

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest()

  for (const part of sigs.split(' ')) {
    const comma = part.indexOf(',')
    const value = comma >= 0 ? part.slice(comma + 1) : part
    let actual: Buffer
    try { actual = Buffer.from(value, 'base64') } catch { continue }
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true
  }
  return false
}
