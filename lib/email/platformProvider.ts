// RD-EMAIL-PROVIDER-04 · The PLATFORM email provider — the Super Admin's one global choice. SERVER-ONLY.
//
// ═══ SOURCE OF TRUTH ═════════════════════════════════════════════════════════
// Business Configuration `integrations.emailProvider` ('ses' | 'resend'), written ONLY through
// the Super Admin Communication Center (PUT /api/admin/communications/email-provider) — which
// refuses a provider whose credentials are absent — or the generic Business Configuration route,
// which applies the same refusal. Every change is versioned and audited by updateSection.
//
// ═══ PRECEDENCE (product decision 2026-10-26, superseding RD-EMAIL-PROVIDER-03) ══
//   1. events/{slug}.emailProvider  — an explicit per-event admin override (event mail only)
//   2. integrations.emailProvider   — THIS: every email that is not overridden, including OTP,
//                                     account, payout, Super Admin alerts, tickets, reminders,
//                                     certificates and broadcasts
//   3. DEFAULT_EMAIL_PROVIDER ('ses') — absent / unreadable / legacy value
//
// ═══ NO SILENT FALLBACK ══════════════════════════════════════════════════════
// If the selected provider later loses its credentials, mail is NOT rerouted to the other
// provider: getEmailProvider(name) returns null and every send reports provider_unavailable,
// which the outbox / email logs / Communication Center make visible. Switching providers is a
// deliberate Super Admin action, never an automatic one.
//
// ═══ CACHING ═════════════════════════════════════════════════════════════════
// businessConfig caches the configuration for 60 s per server instance, so a change reaches
// every instance within about a minute. `platformEmailProviderSnapshot()` is the synchronous
// view for the engine's `isAvailable()` precheck; `resolvePlatformEmailProvider()` is what a
// send uses.

import { businessConfig } from '@/lib/config/businessConfigService'
import { DEFAULT_EMAIL_PROVIDER, parseEmailProviderName, type EmailProviderName } from './providerName'

let snapshot: EmailProviderName | null = null

/** The platform provider for a send. Never throws: an unreadable configuration means SES. */
export async function resolvePlatformEmailProvider(): Promise<EmailProviderName> {
  try {
    const integrations = await businessConfig.getSection('integrations')
    snapshot = parseEmailProviderName((integrations as { emailProvider?: unknown }).emailProvider)
  } catch {
    snapshot = snapshot ?? DEFAULT_EMAIL_PROVIDER
  }
  return snapshot
}

/**
 * The last resolved platform provider, synchronously — or null before the first resolution in
 * this process (a cold start). Each call also refreshes it in the background.
 */
export function platformEmailProviderSnapshot(): EmailProviderName | null {
  void resolvePlatformEmailProvider().catch(() => undefined)
  return snapshot
}

/** After a Super Admin change on THIS instance, so it applies here at once (others within the TTL). */
export function notePlatformEmailProvider(name: EmailProviderName): void {
  snapshot = name
}

/** Test seam. */
export function __resetPlatformEmailProviderSnapshot(): void {
  snapshot = null
}
