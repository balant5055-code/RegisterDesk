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
import type { EmailProviderName } from '@/lib/email/providerName'
import { getNotificationHooks, type NotificationContext, type NotificationHooks } from './hooks'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { resolvePlatformEmailProvider } from '@/lib/email/resolvePlatformProvider'

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
   * delivered, or admit mail that cannot. Omitted ⇒ the platform default, unchanged.
   */
  isAvailable(
    channel: NotificationChannel = NotificationChannel.EMAIL,
    providerName?: EmailProviderName,
  ): boolean {
    return resolveProvider(channel, providerName) !== null
  }

  /** Send a notification. See the behaviour contract at the top of this file. */
  async send<T extends NotificationType>(
    type: T,
    payload: NotificationPayloadMap[T],
    // RD-EMAIL-PROVIDER — OPTIONAL trusted provider for EVENT-scoped mail. Callers with an
    // event resolve it via resolveEventEmailProvider(eventSlug) and pass it here. Omitted
    // (every non-event caller: OTP, settlements, payouts, team, licensing, admin alerts)
    // ⇒ the platform default, i.e. today's SES behaviour, unchanged.
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

    // RD-EMAIL-PROVIDER — the provider a caller did NOT specify.
    //
    // An explicit `providerName` is honoured EXACTLY and never reconsidered: every
    // event-scoped caller resolves its transport from `events/{slug}.emailProvider` via
    // resolveEventEmailProvider() and passes it here, and that decision outranks any
    // platform setting. Only the ABSENCE of a preference is filled in below.
    //
    // Before this, an omitted name went straight to the DEFAULT_EMAIL_PROVIDER code
    // constant, which is why `communication.email.provider` was editable in Business
    // Configuration and controlled nothing. It now controls exactly what it claims to:
    // platform mail. An absent or invalid setting still resolves to DEFAULT_EMAIL_PROVIDER,
    // so a workspace that never touches the field behaves exactly as it does today.
    //
    // Costs no extra I/O: businessConfig caches for 60s and the enabled-check above has
    // already warmed it.
    const effectiveProvider = channel === NotificationChannel.EMAIL && providerName === undefined
      ? await resolvePlatformEmailProvider()
      : providerName

    const provider = resolveProvider(channel, effectiveProvider)
    if (!provider) {
      const result: EmailResult = { success: false, error: 'provider_unavailable' }
      await runHook('afterSend', h => h.afterSend?.(ctx, result))
      return result
    }

    const dispatch = EMAIL_DISPATCHERS[type] as EmailDispatcher<T>

    // RD-ORGANIZER-04 P1-3: bounded retry/backoff for TRANSACTIONAL email only. A send
    // either succeeds, returns { success:false } (SES rejected — not sent), or throws (not
    // sent), so retrying never duplicates a delivered email. Bulk types keep their
    // single-attempt-by-design behaviour. Hooks fire once, on the final outcome.
    const retryable = channel === NotificationChannel.EMAIL && !NON_RETRY_TYPES.has(type)
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await dispatch(provider, payload)
        if (result.success || !retryable || attempt >= MAX_SEND_ATTEMPTS) {
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
