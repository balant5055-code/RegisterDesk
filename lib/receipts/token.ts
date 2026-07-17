// HMAC token for receipt PDF download links.
//
// Uses the same TICKET_SECRET as the ticket token but a different message
// prefix ("receipt:<id>") so receipt tokens cannot be used to download tickets
// and vice versa.

import crypto from 'crypto'
import { TICKET_SECRET } from '@/lib/env'

const HEX_64 = /^[0-9a-f]{64}$/
const PREFIX  = 'receipt:'

export function signReceiptToken(registrationId: string): string {
  return crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(`${PREFIX}${registrationId}`)
    .digest('hex')
}

export function verifyReceiptToken(registrationId: string, token: string): boolean {
  if (!HEX_64.test(token)) return false
  const expected = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(`${PREFIX}${registrationId}`)
    .digest()
  const actual = Buffer.from(token, 'hex')
  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
