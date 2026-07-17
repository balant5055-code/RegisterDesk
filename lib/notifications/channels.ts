// Notification channels — the transports the engine can dispatch over.
//
// Only EMAIL is wired today (Amazon SES-style provider via lib/email). WHATSAPP,
// SMS and PUSH are declared for the Provider Resolver to grow into — no transport
// exists for them yet (see Phase G1.0 audit). Business code must never branch on
// these; it expresses intent through a NotificationType and the engine resolves
// the channel.

export const NotificationChannel = {
  EMAIL:    'email',
  WHATSAPP: 'whatsapp',
  SMS:      'sms',
  PUSH:     'push',
} as const

export type NotificationChannel =
  typeof NotificationChannel[keyof typeof NotificationChannel]
