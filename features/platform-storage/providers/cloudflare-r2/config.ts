// RD-STORAGE-01 · Cloudflare R2 — configuration. SERVER ONLY.
//
// ─── Follows RD-ENV-ARCH-03 ──────────────────────────────────────────────────
// `lib/env.ts` states the rule: only TRUE application-wide dependencies are boot-fatal;
// every FEATURE-specific validation lives at its own subsystem boundary, "so a feature
// misconfiguration fails only that feature, never unrelated routes".
//
// Storage is a feature. The five R2 variables are therefore read as OPTIONAL in lib/env.ts
// and validated HERE. An unconfigured R2 must not stop the app booting, break an OTP login,
// or fail a payment — it must fail exactly one thing: storage.
//
// No secret in this file is ever exported to the client. There is no NEXT_PUBLIC_ variable
// here except the public base URL, which is public by definition.

import {
  R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_URL, R2_SECRET_ACCESS_KEY,
} from '@/lib/env'
import { StorageError } from '@/features/platform-storage/types/errors'

export interface R2Config {
  accountId:       string
  bucket:          string
  accessKeyId:     string
  secretAccessKey: string
  /** Base URL for PUBLIC objects. Empty when no public domain is attached to the bucket. */
  publicUrl:       string
  endpoint:        string
}

/** R2's S3-compatible endpoint. Region is always `auto`. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

export const R2_REGION = 'auto'

/** Which required variables are missing. Empty ⇒ configured. */
export function missingR2Vars(): string[] {
  const missing: string[] = []
  if (!R2_ACCOUNT_ID)        missing.push('R2_ACCOUNT_ID')
  if (!R2_BUCKET)            missing.push('R2_BUCKET')
  if (!R2_ACCESS_KEY_ID)     missing.push('R2_ACCESS_KEY_ID')
  if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY')
  return missing
}

export function isR2Configured(): boolean {
  return missingR2Vars().length === 0
}

/**
 * The validated config, or a `NOT_CONFIGURED` StorageError naming exactly what is missing.
 *
 * `R2_PUBLIC_URL` is deliberately NOT required: a bucket with no public domain is a valid
 * setup — every object is then private or signed, which is the stricter posture.
 */
export function requireR2Config(): R2Config {
  const missing = missingR2Vars()
  if (missing.length > 0) {
    throw new StorageError(
      'NOT_CONFIGURED',
      `Cloudflare R2 is not configured. Missing: ${missing.join(', ')}. `
      + 'Set them in .env.local for development or in your deployment secrets.',
    )
  }

  return {
    accountId:       R2_ACCOUNT_ID,
    bucket:          R2_BUCKET,
    accessKeyId:     R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    publicUrl:       R2_PUBLIC_URL.replace(/\/$/, ''),
    endpoint:        r2Endpoint(R2_ACCOUNT_ID),
  }
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Default signed-URL lifetime. Short: a signed URL is a bearer token. */
export const SIGNED_URL_DEFAULT_SECONDS = 300          // 5 minutes

/** Hard ceiling. AWS SigV4 itself caps presigned URLs at 7 days; we are far stricter. */
export const SIGNED_URL_MAX_SECONDS = 60 * 60 * 24     // 24 hours

/** Page size ceiling for `list`, so one call can never fetch an unbounded page. */
export const LIST_MAX_KEYS = 1000

/** Cache-Control for PUBLIC, immutable objects — the key contains a uuid, so content at a
 *  given key never changes. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Cache-Control for private objects, so no shared cache ever retains them. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store'
