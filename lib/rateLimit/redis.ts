// Distributed rate limiting backed by Upstash Redis (P1-2). Server-only.
//
// Replaces the per-instance in-memory limiter for security-sensitive endpoints:
// on Vercel each serverless instance has its own memory, so an in-memory counter
// cannot enforce a global limit. This module uses a Redis fixed-window counter
// (atomic INCR + EXPIRE via a single EVAL) so the limit holds across ALL instances.
//
// Failure policy:
//   • failOpen:false (default) — Redis error ⇒ DENY. Use for the chokepoints that
//     must never be unprotected: payment verification, OTP verification, API-key auth.
//   • failOpen:true — Redis error ⇒ ALLOW (but still captureError). Use for
//     lower-risk endpoints (broadcast/webhook test, create-order, OTP request)
//     where a Redis outage should not take the flow fully offline.
// Every Redis failure is reported via captureError(scope:'rate_limit').
//
// When Upstash is NOT configured (preview/dev — production fails startup, see
// lib/env.ts), it falls back to the in-memory limiter so local flows still work.

import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from '@/lib/env'
import { captureError } from '@/lib/monitoring/sentry'
import { checkRateLimit } from '@/lib/rateLimit'

// RD-ENV-ARCH-03 — Upstash is the RATE-LIMITER's dependency, so its "required in
// production" enforcement lives HERE (the rate-limiter boundary) rather than in the
// shared lib/env.ts. A missing Upstash config therefore fails only rate-limited
// endpoints at init, not OTP/payments/dashboard. The in-memory fallback below is
// unchanged. Production is detected exactly as env.ts did (VERCEL_ENV in true
// production, else NODE_ENV); skipped during `next build`.
const _isBuildPhase     = process.env.NEXT_PHASE === 'phase-production-build'
const _vercelEnv        = (process.env.VERCEL_ENV ?? '').trim()
const _isRealProduction = _vercelEnv
  ? _vercelEnv === 'production'
  : process.env.NODE_ENV === 'production'

if (!_isBuildPhase && _isRealProduction && (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN)) {
  throw new Error(
    '[env] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in ' +
    'production. Without them, rate limiting falls back to a per-instance in-memory ' +
    'counter that does NOT enforce limits across serverless instances — payment, ' +
    'OTP and API-key abuse protections would be ineffective.\n' +
    '  Hint: create a database at console.upstash.com (Redis) and copy the REST URL + token.',
  )
}

export interface DistributedRateLimitOptions {
  key:           string   // unique identity, e.g. `verify-payment:<ip>`
  limit:         number   // max requests per window
  windowSeconds: number
  failOpen?:     boolean  // default false (fail closed on Redis outage)
}

export interface DistributedRateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number       // epoch ms
}

const KEY_PREFIX = 'rl:'
const REDIS_TIMEOUT_MS = 1500

// Atomic fixed-window: increment, set TTL only on the first hit of the window,
// and return [count, ttlSeconds]. EVAL runs server-side so it is race-free.
const WINDOW_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
  "local t = redis.call('TTL', KEYS[1]) " +
  'return {c, t}'

const configured = (): boolean => !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN

async function evalWindow(key: string, windowSeconds: number): Promise<[number, number]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS)
  try {
    const res = await fetch(UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // Upstash REST: ["EVAL", script, numKeys, key, ...args]
      body: JSON.stringify(['EVAL', WINDOW_SCRIPT, '1', `${KEY_PREFIX}${key}`, String(windowSeconds)]),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`upstash_http_${res.status}`)
    const json = (await res.json()) as { result?: [number, number]; error?: string }
    if (json.error) throw new Error(`upstash_error:${json.error}`)
    if (!Array.isArray(json.result)) throw new Error('upstash_bad_response')
    return [Number(json.result[0]), Number(json.result[1])]
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Distributed fixed-window rate limit. `limit` requests per `windowSeconds` for
 * `key`, enforced across all serverless instances via Upstash Redis.
 */
export async function checkDistributedRateLimit(opts: DistributedRateLimitOptions): Promise<DistributedRateLimitResult> {
  const { key, limit, windowSeconds, failOpen = false } = opts
  const now = Date.now()

  // Preview/dev without Upstash: fall back to the in-memory limiter (production
  // fails startup when Upstash is unset, so this branch never runs in prod).
  if (!configured()) {
    const r = checkRateLimit(key, 'dist', limit, windowSeconds * 1000)
    return { allowed: !r.limited, remaining: r.remaining, resetAt: r.resetAt }
  }

  try {
    const [count, ttl] = await evalWindow(key, windowSeconds)
    const resetAt = now + (ttl > 0 ? ttl * 1000 : windowSeconds * 1000)
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt }
  } catch (err) {
    captureError(err, { scope: 'rate_limit', key, failOpen })
    // Fail closed (deny) unless the caller opted into fail-open.
    return { allowed: failOpen, remaining: 0, resetAt: now + windowSeconds * 1000 }
  }
}
