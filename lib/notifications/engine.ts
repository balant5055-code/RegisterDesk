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
  type NotificationType,
  type NotificationPayloadMap,
} from './catalog'
import { EMAIL_DISPATCHERS, type EmailDispatcher } from './dispatchers'
import { resolveProvider } from './providerResolver'
import { getNotificationHooks, type NotificationContext, type NotificationHooks } from './hooks'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'

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
   */
  isAvailable(channel: NotificationChannel = NotificationChannel.EMAIL): boolean {
    return resolveProvider(channel) !== null
  }

  /** Send a notification. See the behaviour contract at the top of this file. */
  async send<T extends NotificationType>(
    type: T,
    payload: NotificationPayloadMap[T],
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

    const provider = resolveProvider(channel)
    if (!provider) {
      const result: EmailResult = { success: false, error: 'provider_unavailable' }
      await runHook('afterSend', h => h.afterSend?.(ctx, result))
      return result
    }

    try {
      const dispatch = EMAIL_DISPATCHERS[type] as EmailDispatcher<T>
      const result = await dispatch(provider, payload)
      await runHook('afterSend', h => h.afterSend?.(ctx, result))
      return result
    } catch (err) {
      await runHook('onError', h => h.onError?.(ctx, err))
      throw err   // preserve pre-engine propagation semantics
    }
  }
}

export const notificationEngine = new NotificationEngine()
