// THE canonical absolute-URL source for outgoing email. Server-only.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Absolute links were being built in ~25 places by reading process.env directly, with
// THREE different fallbacks that disagreed:
//
//   (process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in')   // certificates
//   (process.env.NEXT_PUBLIC_APP_URL ?? '')                          // tickets, waitlist…
//   (NEXT_PUBLIC_BASE_URL ?? NEXT_PUBLIC_APP_URL ?? 'https://…')     // businessConfig
//
// The `?? ''` variant is the worst: it silently produced links like "/tickets/abc" in a
// real email, which resolve to nothing in a mail client. And none of them could tell that
// a localhost origin was about to be posted to a real recipient — which is exactly how a
// certificate email went out containing http://localhost:3000/verify/certificate/…
//
// ═══ CONTRACT ════════════════════════════════════════════════════════════════
// One variable — NEXT_PUBLIC_APP_URL, the one lib/env already treats as REQUIRED and
// documents as "all email links embed absolute URLs built from this value". No new
// competing variable is introduced.
//
// Never derives from window.location or a request Host header: a transactional email is
// generated on a server, often from a cron or webhook where no request exists at all, and
// trusting an attacker-supplied Host header would let a forged request rewrite the links
// inside somebody else's email.

import { APP_URL } from '@/lib/env'

/** Origins that must never appear in mail leaving the platform. */
const LOCAL_HOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i

export class LocalEmailUrlError extends Error {
  constructor(resolved: string) {
    super(
      'Production email URL is configured with a local development origin ' +
      `(${resolved}). Set NEXT_PUBLIC_APP_URL to the public site URL and redeploy. ` +
      'Refusing to send an email containing unreachable links.',
    )
    this.name = 'LocalEmailUrlError'
  }
}

/** True when this origin would be unreachable for an email recipient. */
export function isLocalOrigin(url: string): boolean {
  return LOCAL_HOST_PATTERN.test(url.trim().replace(/\/+$/, ''))
}

/**
 * The absolute base URL for links embedded in email. No trailing slash.
 *
 * Throws in PRODUCTION when the configured origin is local, rather than sending mail whose
 * every button is dead. Failing here surfaces as a normal send failure — which the
 * certificate delivery path already records with its reason — instead of a "sent" email
 * the recipient cannot use. Locally it returns http://localhost:3000 unchanged, so
 * development mail stays clickable.
 */
export function getEmailAppUrl(): string {
  const base = APP_URL.replace(/\/+$/, '')
  if (process.env.NODE_ENV === 'production' && isLocalOrigin(base)) {
    throw new LocalEmailUrlError(base)
  }
  return base
}

/**
 * An absolute email link for a path. Collapses the slash between base and path, so
 * emailUrl('/verify/x') and emailUrl('verify/x') both yield one separator.
 */
export function emailUrl(path: string): string {
  const base = getEmailAppUrl()
  if (!path) return base
  return `${base}/${path.replace(/^\/+/, '')}`
}
