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
import { Resend }             from 'resend'
import { ResendProvider }     from './resend'
import { DEFAULT_EMAIL_PROVIDER, type EmailProviderName } from './providerName'
import {
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL, SES_FROM_NAME,
  RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
} from '@/lib/env'

// RD-ENV-ARCH-03 — the SES credential validation lives HERE (the email subsystem
// boundary) rather than in the shared lib/env.ts, so a half-configured static
// credential pair fails only when the email module loads — never unrelated routes.
// A sender configured with only one half of a static credential pair is almost
// certainly a misconfiguration — fail fast rather than silently falling back to the
// default credential chain and getting auth errors on the first send. Skipped during
// `next build`.
if (process.env.NEXT_PHASE !== 'phase-production-build' && SES_FROM_EMAIL &&
    Boolean(AWS_ACCESS_KEY_ID) !== Boolean(AWS_SECRET_ACCESS_KEY)) {
  throw new Error(
    '[env] AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together. ' +
    'Provide both for static credentials, or neither to use an attached IAM role.',
  )
}

// The DEFAULT provider identifier. Retained as a constant for the log sites that have no
// event context (platform-level mail). Event-routed sends must stamp the provider they
// actually used — see `providerNameFor` below and the callers in lib/notifications.
export const EMAIL_PROVIDER_NAME: EmailProviderName = DEFAULT_EMAIL_PROVIDER

// PER-PROVIDER cache. A single shared singleton would lock the whole process to whichever
// provider was resolved first, so SES and Resend must cache independently — both have to
// coexist in one server process for per-event routing to work at all.
// undefined = not yet resolved · null = that provider is not configured.
const _cache = new Map<EmailProviderName, EmailProvider | null>()

/** Builds the SES transport, or null when no verified sender is configured. */
function buildSesProvider(): EmailProvider | null {
  // No verified sender ⇒ email is disabled (all sends are skipped silently).
  if (!SES_FROM_EMAIL) return null

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

  return new SESProvider(client, SES_FROM_EMAIL, SES_FROM_NAME || 'RegisterDesk')
}

/** Builds the Resend transport, or null when it is not fully configured. */
function buildResendProvider(): EmailProvider | null {
  // Same rule SES uses: no API key or no verified sender ⇒ this provider is unavailable.
  // The CALLER decides what unavailability means — for an event that explicitly chose
  // Resend it is a hard failure, never a silent downgrade to SES.
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return null
  return new ResendProvider(
    new Resend(RESEND_API_KEY),
    RESEND_FROM_EMAIL,
    RESEND_FROM_NAME || 'RegisterDesk',
  )
}

/**
 * The transport for a provider, or null when that provider is not configured.
 *
 * ZERO-ARGUMENT BEHAVIOUR IS UNCHANGED: `getEmailProvider()` resolves SES exactly as it did
 * before this sprint, so every existing call site — including the ~38 that never pass a
 * provider — keeps behaving identically.
 *
 * ═══ NO SILENT CROSS-PROVIDER FALLBACK ══════════════════════════════════════
 * When `name` is given and that provider is unconfigured this returns NULL. It does not
 * substitute the other provider. An event that explicitly selected Resend must fail
 * loudly and visibly rather than quietly routing through SES, which is still in sandbox
 * and would drop mail to unverified attendees — the precise failure this routing exists
 * to avoid. (An ABSENT event preference is a different case: it resolves to SES upstream,
 * in `parseEmailProviderName`, and never reaches here as 'resend'.)
 */
export function getEmailProvider(name: EmailProviderName = DEFAULT_EMAIL_PROVIDER): EmailProvider | null {
  const cached = _cache.get(name)
  if (cached !== undefined) return cached

  const built = name === 'resend' ? buildResendProvider() : buildSesProvider()
  if (built === null && name === 'resend') {
    console.error(
      '[email] Resend was requested but is not configured — set RESEND_API_KEY and ' +
      'RESEND_FROM_EMAIL. NOT falling back to SES: an explicit provider choice is never ' +
      'silently overridden.',
    )
  }
  _cache.set(name, built)
  return built
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
