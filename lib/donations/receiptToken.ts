// Server-only: HMAC-SHA256 capability token for donation receipt access.
//
// Token = HMAC-SHA256(RECEIPT_TOKEN_SECRET, receiptId) as a 64-char hex string.
// Falls back to TICKET_SECRET so projects that already have that var set work
// without adding a second secret.
//
// The token is included in success-page links and receipt emails.  It grants
// read-only access to one specific receipt — no expiry, since receipts are
// permanent records.

import crypto from 'crypto'
import { RECEIPT_TOKEN_SECRET } from '@/lib/env'

const HEX_64 = /^[0-9a-f]{64}$/

export function signReceiptToken(receiptId: string): string {
  return crypto.createHmac('sha256', RECEIPT_TOKEN_SECRET).update(receiptId).digest('hex')
}

export function verifyReceiptToken(receiptId: string, token: string): boolean {
  if (!HEX_64.test(token)) return false
  const expected = crypto.createHmac('sha256', RECEIPT_TOKEN_SECRET).update(receiptId).digest()
  const actual   = Buffer.from(token, 'hex')
  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
