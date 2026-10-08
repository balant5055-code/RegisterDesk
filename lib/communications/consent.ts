// RD-COMMS-P2-G — which messages a recipient's opt-out controls, and how a skip is described.
// Client-safe, pure.
//
// The classification is the one the notification catalog ALREADY defines
// (lib/notifications/catalog.ts NOTIFICATION_META.group) — nothing new is invented:
//
//   'attendee'   TRANSACTIONAL — registration / payment confirmation, approval, rejection,
//                cancellation, refund, ticket resend, waitlist, certificate-ready, receipts …
//                An organizer opt-out never stops these. Only a hard PLATFORM suppression (an
//                address that bounced or complained) does — enforced in the provider, as before.
//   'platform'   SYSTEM — platform → organizer (licensing, settlement, review, account …). Same.
//   'marketing'  ORGANIZER COMMUNICATION — BROADCAST (organizer broadcasts) and CUSTOM_EMAIL
//                (reminders, auto and custom). These carry an unsubscribe link and are skipped
//                for a recipient who opted out of that organizer, at the send boundary.

import { NOTIFICATION_META, type NotificationType } from '@/lib/notifications/catalog'

/** True for the messages a recipient can opt out of (organizer → attendee, non-transactional). */
export function isOrganizerCommunication(type: NotificationType): boolean {
  return NOTIFICATION_META[type]?.group === 'marketing'
}

/** Recorded on the message log / recipient row when a send is skipped for consent. */
export const SKIP_UNSUBSCRIBED  = 'Not sent — the recipient unsubscribed from your emails'
export const SKIP_UNDELIVERABLE = 'Not sent — this address is not accepting email (earlier messages bounced or were reported)'
