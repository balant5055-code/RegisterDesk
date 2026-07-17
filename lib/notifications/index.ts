// Public surface of the Notification Engine. Business code imports ONLY from here.
//
//   import { notificationEngine, NotificationType } from '@/lib/notifications'
//   await notificationEngine.send(NotificationType.REGISTRATION_CONFIRMATION, params)
//
// Do not import from '@/lib/email' for sending anywhere in business logic — go
// through the engine so provider/template/channel decisions stay in one place.

export { notificationEngine } from './engine'
export { NotificationChannel } from './channels'
export {
  NotificationType,
  NOTIFICATION_META,
  RESERVED_NOTIFICATION_TYPES,
  notificationScope,
  isOrganizerNotification,
} from './catalog'
export type {
  NotificationPayloadMap,
  NotificationMeta,
  NotificationGroup,
  NotificationScope,
  ReviewNotificationParams,
} from './catalog'
export { registerNotificationHooks } from './hooks'
export type { NotificationHooks, NotificationContext } from './hooks'

// Provider discovery — the engine recognizes configured transports per channel.
// WhatsApp (Meta) is discoverable here but is NOT routed any notification yet.
export { isChannelConfigured, resolveWhatsAppProvider } from './providerResolver'
export type { WhatsAppProvider, MetaHealthResult } from '@/lib/whatsapp'
