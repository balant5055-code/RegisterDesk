// Centralized rate-limit POLICIES (EA-3 S2). Server-only.
//
// This is the SINGLE place per-category request quotas live. It deliberately does
// NOT introduce a new limiter — it composes the existing in-process limiter
// (lib/rateLimit.ts). The financial / OTP chokepoints keep using the distributed
// (Redis) limiter (lib/rateLimit/redis.ts); these policies cover authenticated
// low-frequency mutations and expensive public generation endpoints, where a
// per-instance counter is appropriate defense-in-depth against abuse/automation.
//
// NOT blanket: each policy is scoped to an endpoint CATEGORY with a quota matched
// to that category's cost and legitimate usage (a payment ≠ a report export ≠ an
// image upload ≠ a PDF download ≠ public registration). Routes reference a named
// policy instead of hand-rolling magic numbers, so quotas stay consistent and
// auditable in one file.

import { checkRateLimit } from '@/lib/rateLimit'

export interface RatePolicy {
  route:    string   // limiter namespace (keeps categories from sharing a bucket)
  limit:    number   // max requests per window per identifier
  windowMs: number
}

const MIN  = 60 * 1000
const HOUR = 60 * MIN

/**
 * Named policies by endpoint category. Identifiers are the organizer uid for
 * authenticated mutations, or the client IP for public/expensive generation.
 */
export const RATE_POLICY = {
  // Sensitive account mutations (per organizer uid) — abuse / accidental-repeat guard.
  accountDeletion: { route: 'account-delete',  limit: 3,  windowMs: HOUR },  // irreversible
  teamInvite:      { route: 'team-invite',      limit: 20, windowMs: HOUR },  // sends email
  brandingUpdate:  { route: 'branding-update',  limit: 30, windowMs: HOUR },
  apiKeyCreate:    { route: 'api-key-create',   limit: 10, windowMs: HOUR },  // creates a credential

  // Expensive on-the-fly PDF generation (per client IP) — CPU-exhaustion guard.
  pdfDownload:     { route: 'pdf-download',      limit: 60, windowMs: MIN },

  // Unauthenticated public application forms (per client IP) — spam / write- and
  // email-amplification guard. Tolerant of shared-NAT applicants (10/hour).
  publicApplication: { route: 'public-application', limit: 10, windowMs: HOUR },
} as const satisfies Record<string, RatePolicy>

export interface PolicyCheck {
  limited:    boolean
  retryAfter: number   // seconds — for the Retry-After header
}

/**
 * Applies a centralized policy to an identifier (organizer uid or client IP).
 * Reuses the in-process fixed-window limiter; returns whether to block plus a
 * Retry-After value. Routes build their own 429 in their existing response shape
 * (kept backward-compatible), e.g.:
 *
 *   const rl = checkPolicy(uid, RATE_POLICY.accountDeletion)
 *   if (rl.limited) return NextResponse.json(
 *     { error: 'Too many requests. Please try again later.' },
 *     { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } })
 */
export function checkPolicy(identifier: string, policy: RatePolicy): PolicyCheck {
  const r = checkRateLimit(identifier, policy.route, policy.limit, policy.windowMs)
  return { limited: r.limited, retryAfter: Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000)) }
}
