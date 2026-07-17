// Provider Resolver — the single seam between the Notification Engine and concrete
// transports. This is the ONLY module (besides lib/email's own internals) that is
// allowed to obtain a provider instance. Business code asks the engine; the engine
// asks the resolver; the resolver picks the transport for a channel.
//
// Current: EMAIL → the existing email provider (Resend today, SES-swappable).
// Future:  WHATSAPP → Meta Cloud API provider, SMS → SMS provider, PUSH → push
//          provider. Add a case below and a channel entry — nothing else changes.

import { getEmailProvider } from '@/lib/email'
import type { EmailProvider } from '@/lib/email/provider'
import { getMetaProvider, isMetaConfigured } from '@/lib/whatsapp'
import type { WhatsAppProvider } from '@/lib/whatsapp'
import { NotificationChannel } from './channels'

// The engine's send path resolves ONLY the email channel through here, so this
// function's return type stays EmailProvider — dispatch typing is unaffected.
// WhatsApp/SMS/Push are intentionally NOT routed: they return null so no
// notification can be dispatched to them yet (Phase G3.1 is foundation-only).
export function resolveProvider(channel: NotificationChannel): EmailProvider | null {
  switch (channel) {
    case NotificationChannel.EMAIL:
      return getEmailProvider()

    // WhatsApp (Meta) is DISCOVERABLE via resolveWhatsAppProvider() below, but is
    // deliberately not routed here — no notification type targets it. SMS/Push
    // have no transport yet.
    case NotificationChannel.WHATSAPP:
    case NotificationChannel.SMS:
    case NotificationChannel.PUSH:
    default:
      return null
  }
}

// ─── Provider discovery (additive — does not change the email send path) ───────

/**
 * Whether a channel's transport is configured. Lets the platform discover/report
 * provider availability per channel without coupling to a concrete provider type.
 * EMAIL (SES) + WHATSAPP (Meta) are known today.
 */
export function isChannelConfigured(channel: NotificationChannel): boolean {
  switch (channel) {
    case NotificationChannel.EMAIL:    return getEmailProvider() !== null
    // Sync configured-check (secrets presence) — decoupled from the now-async
    // provider factory so notification availability checks stay synchronous.
    case NotificationChannel.WHATSAPP: return isMetaConfigured()
    default:                           return false
  }
}

/**
 * Resolve the WhatsApp (Meta Cloud API) provider for configuration/health checks.
 * Returns null when WhatsApp is not configured. This is the registration seam the
 * Notification Engine uses to recognize Meta; it is NOT wired into the send path.
 * Async since RD-CONF-12 (provider policy is resolved from config).
 */
export async function resolveWhatsAppProvider(): Promise<WhatsAppProvider | null> {
  return getMetaProvider()
}
