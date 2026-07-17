// Monitoring & Alerting (P0-1) — server-only.
//
// Design contract (all three are guaranteed):
//   1. NEVER throws — every Sentry interaction is wrapped; a logging failure can
//      never block or break business logic.
//   2. NEVER loses the log — the console.error is ALWAYS emitted (serverless-safe,
//      survives even if Sentry drops/flushes late), then the event is ALSO sent to
//      Sentry as an alert when a DSN is configured.
//   3. Falls back to console.error when Sentry is unavailable (no DSN, SDK load
//      failure, or capture error).
//
// Sentry is initialized lazily once (gated on SENTRY_DSN). @sentry/node is imported
// dynamically so this module stays inert until first use and never affects edge
// bundles. captureFinancialError / captureWebhookError tag events so alerts route.

import { SENTRY_DSN, SENTRY_ENVIRONMENT } from '@/lib/env'

export interface ErrorContext {
  scope?: string                       // short label, e.g. 'donation.complete'
  [key: string]: unknown               // arbitrary structured extra data
}

type Area = 'app' | 'financial' | 'webhook'

interface SentryLike {
  init: (opts: Record<string, unknown>) => void
  captureException: (e: unknown, hint?: Record<string, unknown>) => void
  flush?: (timeout?: number) => Promise<boolean>
}

let sentry: SentryLike | null = null
let initStarted = false

// Kick off init once. Resolves quickly at startup; captures before it resolves
// simply fall back to console (no log is ever lost).
function ensureInit(): void {
  if (initStarted) return
  initStarted = true
  if (!SENTRY_DSN) return                // no DSN → console-only mode
  void (async () => {
    try {
      const mod = (await import('@sentry/node')) as unknown as SentryLike
      mod.init({
        dsn: SENTRY_DSN,
        environment: SENTRY_ENVIRONMENT,
        tracesSampleRate: 0,             // errors only; no perf overhead
        // Keep events lean + avoid PII surprises from default integrations.
        sendDefaultPii: false,
      })
      sentry = mod
    } catch {
      sentry = null                      // SDK unavailable → stay in console mode
    }
  })()
}
ensureInit()

function asError(error: unknown): Error {
  if (error instanceof Error) return error
  try { return new Error(typeof error === 'string' ? error : JSON.stringify(error)) }
  catch { return new Error('Non-serializable error') }
}

function safeContext(context?: ErrorContext): Record<string, unknown> | undefined {
  if (!context) return undefined
  try { JSON.stringify(context); return context }       // ensure serializable
  catch { return { scope: String(context.scope ?? '') } }
}

// The single emit path: console ALWAYS, Sentry best-effort. Never throws.
function emit(area: Area, error: unknown, context?: ErrorContext): void {
  // 1) Preserve the log unconditionally.
  try {
    const label = context?.scope ? `[${area}:${context.scope}]` : `[${area}]`
    console.error(label, error, context ? safeContext(context) : '')
  } catch { /* console must never break the caller */ }

  // 2) Best-effort alert to Sentry.
  try {
    if (sentry) {
      sentry.captureException(asError(error), {
        level: 'error',
        tags: { area, scope: context?.scope ?? 'unknown' },
        extra: safeContext(context),
      })
    }
  } catch { /* swallow — alerting must never break the caller */ }
}

/** General application / API-route error. */
export function captureError(error: unknown, context?: ErrorContext): void {
  emit('app', error, context)
}

/** Money-path error (payments, donations, refunds, settlements, wallet credits,
 *  reconciliation, clawbacks, subscription billing). Tagged area:'financial'. */
export function captureFinancialError(error: unknown, context?: ErrorContext): void {
  emit('financial', error, context)
}

/** Webhook ingestion / delivery error. Tagged area:'webhook'. */
export function captureWebhookError(error: unknown, context?: ErrorContext): void {
  emit('webhook', error, context)
}

/** Flush queued events before a short-lived (serverless / cron) handler exits.
 *  Never throws; no-op when Sentry is inactive. Call before returning from crons
 *  to maximize delivery of events captured during the run. */
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  try { if (sentry?.flush) await sentry.flush(timeoutMs) } catch { /* ignore */ }
}
