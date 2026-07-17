// Logging hooks — extension points ONLY. Phase G2.2 deliberately ships these as
// no-ops: no database logging, no communicationLog collection, no analytics. A
// later phase can register hooks (e.g. to write a communication log or emit
// metrics) without touching any business code or the engine's send path.
//
// Hooks are best-effort: the engine guards every invocation so a throwing hook can
// never break an outbound notification.

import type { NotificationType } from './catalog'
import type { NotificationChannel } from './channels'
import type { EmailResult } from '@/lib/email/provider'

export interface NotificationContext {
  type:       NotificationType
  channel:    NotificationChannel
  recipient?: string
}

export interface NotificationHooks {
  /** Fired before dispatch. */
  beforeSend?(ctx: NotificationContext): void | Promise<void>
  /** Fired after a dispatch attempt resolves (success or provider-unavailable). */
  afterSend?(ctx: NotificationContext, result: EmailResult): void | Promise<void>
  /** Fired when the dispatch threw. The engine re-throws after this hook. */
  onError?(ctx: NotificationContext, error: unknown): void | Promise<void>
}

let _hooks: NotificationHooks = {}

/** Register (merge) notification hooks. Later registrations override earlier keys. */
export function registerNotificationHooks(hooks: NotificationHooks): void {
  _hooks = { ..._hooks, ...hooks }
}

export function getNotificationHooks(): NotificationHooks {
  return _hooks
}
