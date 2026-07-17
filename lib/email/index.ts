// Email provider factory — server-only.
//
// Amazon SES is the sole production email provider. Environment variables are
// validated at startup by lib/env.ts:
//   AWS_REGION             SES region (defaults to ap-south-1 / Mumbai)
//   AWS_ACCESS_KEY_ID      Static IAM credentials (optional when running under an
//   AWS_SECRET_ACCESS_KEY    attached IAM role — the SDK default chain is used then)
//   SES_FROM_EMAIL         Verified sender address; unset ⇒ email disabled
//   SES_FROM_NAME          From display name (defaults to "RegisterDesk")
//
// Calling code pattern (via the Notification Engine — never imported directly):
//   const provider = getEmailProvider()
//   if (!provider) return  // email not configured — skip silently
//
// Email failures must NEVER break registration, check-in, or ticket generation.

import { SESv2Client } from '@aws-sdk/client-sesv2'
import type { EmailProvider } from './provider'
import { SESProvider }        from './ses'
import {
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL, SES_FROM_NAME,
} from '@/lib/env'

// The active provider identifier, recorded on email logs.
export const EMAIL_PROVIDER_NAME = 'ses'

// Module-level cache — safe in Lambda/Edge since env vars are stable within a
// cold-start lifecycle.  null means "email disabled", undefined means "not yet resolved".
let _cache: EmailProvider | null | undefined = undefined

export function getEmailProvider(): EmailProvider | null {
  if (_cache !== undefined) return _cache

  // No verified sender ⇒ email is disabled (all sends are skipped silently).
  if (!SES_FROM_EMAIL) {
    _cache = null
    return null
  }

  // Explicit static credentials when provided; otherwise fall back to the SDK's
  // default credential chain (IAM role / instance profile). maxAttempts: 1
  // disables the SDK's built-in retries — retry is out of scope for this phase.
  const client = new SESv2Client({
    region:      AWS_REGION || 'ap-south-1',
    maxAttempts: 1,
    ...(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }
      : {}),
  })

  _cache = new SESProvider(client, SES_FROM_EMAIL, SES_FROM_NAME || 'RegisterDesk')
  return _cache
}

/** Format a stored YYYY-MM-DD date string for use in email copy. */
export function fmtEmailDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}
