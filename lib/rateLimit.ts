// In-process sliding-window rate limiter using a module-level Map.
//
// TRADE-OFF: Each Lambda / Edge function instance maintains its own counter.
// This effectively blocks a single attacker hammering one instance but does NOT
// stop distributed attacks spread across many instances.  For distributed rate
// limiting replace this module with @upstash/ratelimit backed by a Redis
// instance and call it from Next.js middleware.

interface Window {
  count:       number
  windowStart: number  // epoch ms
}

const store   = new Map<string, Window>()
let lastSweep = 0

/** Evicts expired windows to prevent unbounded Map growth on long-lived instances. */
function sweep(windowMs: number): void {
  const now = Date.now()
  if (now - lastSweep < 60_000) return  // sweep at most once per minute
  lastSweep = now
  for (const [key, w] of store) {
    if (now - w.windowStart >= windowMs) store.delete(key)
  }
}

export interface RateLimitResult {
  limited:   boolean
  remaining: number
  resetAt:   number  // epoch ms
}

/**
 * Fixed-window counter: `limit` requests per `windowMs` milliseconds per
 * `identifier` (typically an IP address) scoped to `route`.
 *
 * Using `route` as a namespace lets different endpoints have different quotas
 * for the same client without interfering with each other.
 */
export function checkRateLimit(
  identifier: string,
  route:      string,
  limit:      number,
  windowMs:   number,
): RateLimitResult {
  sweep(windowMs)

  const key = `${route}:${identifier}`
  const now = Date.now()
  const w   = store.get(key)

  if (!w || now - w.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now })
    return { limited: false, remaining: limit - 1, resetAt: now + windowMs }
  }

  w.count += 1
  const resetAt = w.windowStart + windowMs

  if (w.count > limit) {
    return { limited: true, remaining: 0, resetAt }
  }

  return { limited: false, remaining: limit - w.count, resetAt }
}

/**
 * Extracts the best available client IP from a Next.js/Node request.
 * On Vercel and most CDN setups, x-forwarded-for is the reliable source.
 */
export function getClientIp(req: { headers: { get(key: string): string | null } }): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return 'unknown'
}
