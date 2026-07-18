// Distributed rate-limit adapter (RD-REDIS-REMOVE). Server-only.
//
// Upstash Redis was removed as an infrastructure dependency. It stored ZERO business
// state and only provided cross-instance IP throttling — payment correctness (Firestore
// transactions + deterministic ledger ids) and OTP correctness (Firestore otpRequests /
// otpRateLimits / attendeeOtp* + per-email attempt counters) never depended on it.
//
// This module keeps the SAME public API (checkDistributedRateLimit + its option/result
// types) so every caller is unchanged, but now delegates to the existing in-process
// fixed-window limiter (lib/rateLimit.ts) — exactly the fallback path this module already
// used when Upstash was unconfigured. Same limits, windows, and result shape; the only
// difference is per-instance counting instead of cross-instance. No external service, no
// new dependency, no startup coupling, no Upstash env vars.

import { checkRateLimit } from '@/lib/rateLimit'

export interface DistributedRateLimitOptions {
  key:           string   // unique identity, e.g. `verify-payment:<ip>`
  limit:         number    // max requests per window
  windowSeconds: number
  // Retained for call-site compatibility. The in-process limiter has no external backend
  // that can fail, so this flag is a no-op (the limiter always returns a deterministic
  // result). Kept so existing callers pass it without a signature change.
  failOpen?:     boolean
}

export interface DistributedRateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number       // epoch ms
}

/**
 * Fixed-window rate limit: `limit` requests per `windowSeconds` for `key`, enforced per
 * serverless instance via the in-process limiter (lib/rateLimit.ts). The async signature
 * is preserved so existing `await` call sites remain byte-for-byte unchanged.
 */
export async function checkDistributedRateLimit(opts: DistributedRateLimitOptions): Promise<DistributedRateLimitResult> {
  const { key, limit, windowSeconds } = opts
  const r = checkRateLimit(key, 'dist', limit, windowSeconds * 1000)
  return { allowed: !r.limited, remaining: r.remaining, resetAt: r.resetAt }
}
