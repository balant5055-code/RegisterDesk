// Server-only encryption for payout PII (PAN / account number / IFSC).
//
// AES-256-GCM with a key derived from PAYOUT_PII_SECRET. Stored format:
//   enc:v1:<base64(iv | authTag | ciphertext)>
//
// decryptPii is backward-compatible: a value WITHOUT the `enc:v1:` prefix is
// treated as legacy plaintext and returned unchanged, so existing unencrypted
// profiles keep working until they are next saved (and re-encrypted).

import crypto from 'crypto'
import { PAYOUT_PII_SECRET } from '@/lib/env'

const PREFIX  = 'enc:v1:'
const IV_LEN  = 12   // GCM standard nonce length
const TAG_LEN = 16

// Derive a stable 32-byte key from the configured secret.
const KEY = crypto.createHash('sha256').update(PAYOUT_PII_SECRET).digest()

/** Encrypts a plaintext PII string. Empty/falsy input is returned unchanged. */
export function encryptPii(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return plain ?? null
  const iv     = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct     = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}

/**
 * Decrypts a value produced by encryptPii. A value without the `enc:v1:` prefix
 * is assumed to be legacy plaintext and returned as-is. Returns null on any
 * decryption failure (tampered/corrupt ciphertext) rather than throwing.
 */
export function decryptPii(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return stored ?? null
  if (!stored.startsWith(PREFIX)) return stored   // legacy plaintext
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64')
    const iv  = raw.subarray(0, IV_LEN)
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct  = raw.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
