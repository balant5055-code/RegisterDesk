// The Notification Engine — the ONE public entry point for sending any
// notification in RegisterDesk. Nothing outside lib/notifications may talk to a
// provider directly.
//
//   notificationEngine.send(NotificationType.X, payload)
//
// The caller expresses business intent (a NotificationType + its typed payload).
// The engine decides the channel, resolves the provider, resolves the template/
// dispatcher, fires logging hooks, and returns the result. Provider knowledge,
// template ids, and channel selection never leak to business code.
//
// Behaviour contract (Phase G2.2 — zero behaviour change):
//   • Returns the provider's EmailResult unchanged on a normal dispatch.
//   • Provider unavailable → { success: false, error: 'provider_unavailable' }
//     (callers already guard with isAvailable(), matching the old
//     `if (!getEmailProvider()) return`).
//   • A dispatch that throws is re-thrown after onError, preserving the previous
//     exception-propagation semantics of a bare `provider.sendX()` call.

import type { EmailResult } from '@/lib/email/provider'
import { NotificationChannel } from './channels'
import {
  NOTIFICATION_META,
  NotificationType,
  type NotificationPayloadMap,
} from './catalog'
import { EMAIL_DISPATCHERS, type EmailDispatcher } from './dispatchers'
import { resolveProvider } from './providerResolver'
import { EMAIL_PROVIDER_NAMES, type EmailProviderName } from '@/lib/email/providerName'
import { resolvePlatformEmailProvider, platformEmailProviderSnapshot } from '@/lib/email/platformProvider'
import { getNotificationHooks, type NotificationContext, type NotificationHooks } from './hooks'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'

// RD-ORGANIZER-04 P1-3: bulk send types run their own resumable job/wave machinery and are
// single-attempt by design — only TRANSACTIONAL emails get automatic bounded retry.
const NON_RETRY_TYPES = new Set<NotificationType>([NotificationType.BROADCAST, NotificationType.CUSTOM_EMAIL])
const MAX_SEND_ATTEMPTS = 3
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function channelForType(type: NotificationType): NotificationChannel {
  return NOTIFICATION_META[type]?.channel ?? NotificationChannel.EMAIL
}

// Hooks must never break a send — invoke defensively.
async function runHook<K extends keyof NotificationHooks>(
  name: K,
  invoke: (hooks: NotificationHooks) => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await invoke(getNotificationHooks())
  } catch (err) {
    console.error(`[notifications] hook "${String(name)}" threw (ignored):`, err)
  }
}

class NotificationEngine {
  /**
   * Whether the transport for a channel is configured. Callers use this to keep
   * the old `if (!provider) return` short-circuit without touching a provider.
   *
   * RD-EMAIL-PROVIDER — pass `providerName` wherever the matching `send()` passes one.
   * The gate must ask about the SAME transport that will actually carry the message:
   * asking about SES and then sending through Resend can skip mail that would have
   * delivered, or admit mail that cannot. Omitted ⇒ the PLATFORM provider (the Super Admin's
   * choice, lib/email/platformProvider), from its synchronous snapshot. Before the first
   * resolution in a process that snapshot is unknown, so the precheck asks whether ANY provider
   * is configured instead of guessing one: it never skips mail that would deliver, and send()
   * then uses the resolved choice (reporting provider_unavailable if it is not configured).
   */
  isAvailable(
    channel: NotificationChannel = NotificationChannel.EMAIL,
    providerName?: EmailProviderName,
  ): boolean {
    if (providerName || channel !== NotificationChannel.EMAIL) return resolveProvider(channel, providerName) !== null
    const platform = platformEmailProviderSnapshot()
    if (platform) return resolveProvider(channel, platform) !== null
    return EMAIL_PROVIDER_NAMES.some(n => resolveProvider(channel, n) !== null)
  }

  /** Send a notification. See the behaviour contract at the top of this file. */
  async send<T extends NotificationType>(
    type: T,
    payload: NotificationPayloadMap[T],
    // RD-EMAIL-PROVIDER — OPTIONAL trusted provider for EVENT-scoped mail. Callers with an
    // event resolve it via resolveEventEmailProvider(eventSlug) and pass it here. Omitted
    // (every non-event caller: OTP, settlements, payouts, team, licensing, admin alerts)
    // ⇒ the PLATFORM provider chosen by the Super Admin (RD-EMAIL-PROVIDER-04; default SES).
    providerName?: EmailProviderName,
  ): Promise<EmailResult> {
    const channel = channelForType(type)
    const ctx: NotificationContext = {
      type,
      channel,
      recipient: (payload as { to?: string }).to,
    }

    await runHook('beforeSend', h => h.beforeSend?.(ctx))

    // Communication policy (Business Configuration): the email channel can be
    // disabled platform-wide. Default is enabled, so behaviour is unchanged unless
    // an admin turns it off. Other channels are unaffected here.
    if (channel === NotificationChannel.EMAIL) {
      const comm = await getCommunicationConfig()
      if (!comm.email.enabled) {
        const result: EmailResult = { success: false, error: 'email_disabled' }
        await runHook('afterSend', h => h.afterSend?.(ctx, result))
        return result
      }
    }

    // RD-EMAIL-PROVIDER-04 — nothing named ⇒ the platform provider. Never a silent fallback: if it
    // is not configured, this send reports provider_unavailable.
    const effectiveProvider = channel === NotificationChannel.EMAIL ? (providerName ?? await resolvePlatformEmailProvider()) : providerName
    const provider = resolveProvider(channel, effectiveProvider)
    if (!provider) {
      const result: EmailResult = { success: false, error: 'provider_unavailable' }
      await runHook('afterSend', h => h.afterSend?.(ctx, result))
      return result
    }

    const dispatch = EMAIL_DISPATCHERS[type] as EmailDispatcher<T>

    // RD-ORGANIZER-04 P1-3: bounded retry/backoff for TRANSACTIONAL email only. Bulk types keep
    // their single-attempt-by-design behaviour. Hooks fire once, on the final outcome.
    // RD-COMMS-P2-D — ONLY a DEFINITE rejection is retried. A result with `deliveryUnknown` (timeout,
    // dropped connection, 5xx — the provider may already have accepted it) is final: resending it is
    // how a recipient got the same email two or three times. A suppressed recipient is final too.
    const retryable = channel === NotificationChannel.EMAIL && !NON_RETRY_TYPES.has(type)
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await dispatch(provider, payload)
        if (result.success || !retryable || result.deliveryUnknown || result.suppressed || attempt >= MAX_SEND_ATTEMPTS) {
          await runHook('afterSend', h => h.afterSend?.(ctx, result))
          return result
        }
      } catch (err) {
        if (!retryable || attempt >= MAX_SEND_ATTEMPTS) {
          await runHook('onError', h => h.onError?.(ctx, err))
          throw err   // preserve pre-engine propagation semantics
        }
      }
      await sleep(200 * 2 ** (attempt - 1))   // 200ms, then 400ms
    }
  }
}

export const notificationEngine = new NotificationEngine()
