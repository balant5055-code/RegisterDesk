// Notification catalog — the strongly-typed source of truth for every business
// event that results in an outbound notification. Business code references these
// symbols (never raw strings, never provider method names, never template ids).
//
// Each type is bound to its payload shape via NotificationPayloadMap, so
// `notificationEngine.send(NotificationType.X, payload)` is fully type-checked:
// the wrong payload for a type is a compile error.
//
// Payload interfaces are REUSED verbatim from the existing email provider contract
// (lib/email/provider) — the engine adds an intent layer above them, it does not
// re-model them.

import type {
  OtpEmailParams,
  WelcomeEmailParams,
  RegistrationEmailParams,
  TicketEmailParams,
  EventCancelledEmailParams,
  EventUpdatedEmailParams,
  CertificateEmailParams,
  RegistrationRejectedEmailParams,
  RegistrationCancelledEmailParams,
  RefundConfirmationEmailParams,
  WaitlistJoinedEmailParams,
  SpotAvailableEmailParams,
  DonationReceiptEmailParams,
  Donation80GEmailParams,
  ApplicationReceivedEmailParams,
  ApplicationStatusEmailParams,
  SettlementApprovedEmailParams,
  SettlementRejectedEmailParams,
  SettlementPaidEmailParams,
  PayoutProfileVerifiedEmailParams,
  PayoutProfileRejectedEmailParams,
  CustomEmailParams,
} from '@/lib/email/provider'
import { NotificationChannel } from './channels'

// Params for the event-review family. The engine owns the template (subject +
// HTML) for these; callers pass only the business facts.
export interface ReviewNotificationParams {
  to:        string
  eventName: string
  reason?:   string   // rejection reason
  comment?:  string   // changes-requested comment
}

// Billing lifecycle params (platform → organizer). The engine owns the email
// template for these; callers pass only the business facts.
export interface LicensePurchasedEmailParams {
  to:            string
  organizerName: string
  eventName:     string
  tierName:      string
  amountPaise:   number
}

export interface WalletRechargedEmailParams {
  to:              string
  organizerName:   string
  amountPaise:     number
  newBalancePaise: number
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export const NotificationType = {
  // Auth & onboarding (platform → user)
  EMAIL_VERIFICATION:       'EMAIL_VERIFICATION',
  ACCOUNT_WELCOME:          'ACCOUNT_WELCOME',

  // Event review workflow (platform → organizer)
  EVENT_SUBMITTED:          'EVENT_SUBMITTED',
  EVENT_APPROVED:           'EVENT_APPROVED',
  EVENT_REJECTED:           'EVENT_REJECTED',
  EVENT_CHANGES_REQUESTED:  'EVENT_CHANGES_REQUESTED',
  EVENT_RESUBMITTED:        'EVENT_RESUBMITTED',

  // Registration lifecycle (organizer → attendee)
  REGISTRATION_CONFIRMATION:'REGISTRATION_CONFIRMATION',
  REGISTRATION_APPROVED:    'REGISTRATION_APPROVED',
  REGISTRATION_REJECTED:    'REGISTRATION_REJECTED',
  REGISTRATION_CANCELLED:   'REGISTRATION_CANCELLED',
  TICKET_RESENT:            'TICKET_RESENT',
  EVENT_CANCELLED:          'EVENT_CANCELLED',
  EVENT_UPDATED:            'EVENT_UPDATED',
  REFUND_SUCCESS:           'REFUND_SUCCESS',
  WAITLIST_JOINED:          'WAITLIST_JOINED',
  WAITLIST_SPOT_AVAILABLE:  'WAITLIST_SPOT_AVAILABLE',
  CERTIFICATE_READY:        'CERTIFICATE_READY',

  // Donations (organizer → donor)
  DONATION_RECEIPT:         'DONATION_RECEIPT',
  DONATION_80G_RECEIPT:     'DONATION_80G_RECEIPT',

  // Speaker / sponsor applications
  APPLICATION_RECEIVED:     'APPLICATION_RECEIVED',
  APPLICATION_STATUS:       'APPLICATION_STATUS',

  // Settlement & payout (platform → organizer)
  SETTLEMENT_APPROVED:      'SETTLEMENT_APPROVED',
  SETTLEMENT_REJECTED:      'SETTLEMENT_REJECTED',
  SETTLEMENT_PAID:          'SETTLEMENT_PAID',
  PAYOUT_PROFILE_VERIFIED:  'PAYOUT_PROFILE_VERIFIED',
  PAYOUT_PROFILE_REJECTED:  'PAYOUT_PROFILE_REJECTED',

  // Billing lifecycle (platform → organizer)
  LICENSE_PURCHASED:        'LICENSE_PURCHASED',
  WALLET_RECHARGED:         'WALLET_RECHARGED',

  // Marketing / free-form (organizer → attendee)
  CUSTOM_EMAIL:             'CUSTOM_EMAIL',
  BROADCAST:                'BROADCAST',
} as const

export type NotificationType =
  typeof NotificationType[keyof typeof NotificationType]

// Binds each notification type to its payload shape. Keys MUST equal the
// NotificationType values (asserted at the bottom of this file).
export type NotificationPayloadMap = {
  EMAIL_VERIFICATION:        OtpEmailParams
  ACCOUNT_WELCOME:           WelcomeEmailParams

  EVENT_SUBMITTED:           ReviewNotificationParams
  EVENT_APPROVED:            ReviewNotificationParams
  EVENT_REJECTED:            ReviewNotificationParams
  EVENT_CHANGES_REQUESTED:   ReviewNotificationParams
  EVENT_RESUBMITTED:         ReviewNotificationParams

  REGISTRATION_CONFIRMATION: RegistrationEmailParams
  REGISTRATION_APPROVED:     RegistrationEmailParams
  REGISTRATION_REJECTED:     RegistrationRejectedEmailParams
  REGISTRATION_CANCELLED:    RegistrationCancelledEmailParams
  TICKET_RESENT:             TicketEmailParams
  EVENT_CANCELLED:           EventCancelledEmailParams
  EVENT_UPDATED:             EventUpdatedEmailParams
  REFUND_SUCCESS:            RefundConfirmationEmailParams
  WAITLIST_JOINED:           WaitlistJoinedEmailParams
  WAITLIST_SPOT_AVAILABLE:   SpotAvailableEmailParams
  CERTIFICATE_READY:         CertificateEmailParams

  DONATION_RECEIPT:          DonationReceiptEmailParams
  DONATION_80G_RECEIPT:      Donation80GEmailParams

  APPLICATION_RECEIVED:      ApplicationReceivedEmailParams
  APPLICATION_STATUS:        ApplicationStatusEmailParams

  SETTLEMENT_APPROVED:       SettlementApprovedEmailParams
  SETTLEMENT_REJECTED:       SettlementRejectedEmailParams
  SETTLEMENT_PAID:           SettlementPaidEmailParams
  PAYOUT_PROFILE_VERIFIED:   PayoutProfileVerifiedEmailParams
  PAYOUT_PROFILE_REJECTED:   PayoutProfileRejectedEmailParams

  LICENSE_PURCHASED:         LicensePurchasedEmailParams
  WALLET_RECHARGED:          WalletRechargedEmailParams

  CUSTOM_EMAIL:              CustomEmailParams
  BROADCAST:                 CustomEmailParams
}

// Audience grouping mirrors the Phase G1.0 charging audit (Group A/B/C). Only the
// channel is consumed by the engine today; `group` is metadata for future wallet
// gating and logging — it changes no behaviour now.
export type NotificationGroup = 'platform' | 'attendee' | 'marketing'

export interface NotificationMeta {
  channel: NotificationChannel
  group:   NotificationGroup
}

const PLATFORM = (): NotificationMeta => ({ channel: NotificationChannel.EMAIL, group: 'platform'  })
const ATTENDEE = (): NotificationMeta => ({ channel: NotificationChannel.EMAIL, group: 'attendee'  })
const MARKETING = (): NotificationMeta => ({ channel: NotificationChannel.EMAIL, group: 'marketing' })

export const NOTIFICATION_META: Record<NotificationType, NotificationMeta> = {
  EMAIL_VERIFICATION:        PLATFORM(),
  ACCOUNT_WELCOME:           PLATFORM(),
  EVENT_SUBMITTED:           PLATFORM(),
  EVENT_APPROVED:            PLATFORM(),
  EVENT_REJECTED:            PLATFORM(),
  EVENT_CHANGES_REQUESTED:   PLATFORM(),
  EVENT_RESUBMITTED:         PLATFORM(),
  REGISTRATION_CONFIRMATION: ATTENDEE(),
  REGISTRATION_APPROVED:     ATTENDEE(),
  REGISTRATION_REJECTED:     ATTENDEE(),
  REGISTRATION_CANCELLED:    ATTENDEE(),
  TICKET_RESENT:             ATTENDEE(),
  EVENT_CANCELLED:           ATTENDEE(),
  EVENT_UPDATED:             ATTENDEE(),
  REFUND_SUCCESS:            ATTENDEE(),
  WAITLIST_JOINED:           ATTENDEE(),
  WAITLIST_SPOT_AVAILABLE:   ATTENDEE(),
  CERTIFICATE_READY:         ATTENDEE(),
  DONATION_RECEIPT:          ATTENDEE(),
  DONATION_80G_RECEIPT:      ATTENDEE(),
  APPLICATION_RECEIVED:      PLATFORM(),
  APPLICATION_STATUS:        PLATFORM(),
  SETTLEMENT_APPROVED:       PLATFORM(),
  SETTLEMENT_REJECTED:       PLATFORM(),
  SETTLEMENT_PAID:           PLATFORM(),
  PAYOUT_PROFILE_VERIFIED:   PLATFORM(),
  PAYOUT_PROFILE_REJECTED:   PLATFORM(),
  LICENSE_PURCHASED:         PLATFORM(),
  WALLET_RECHARGED:          PLATFORM(),
  CUSTOM_EMAIL:              MARKETING(),
  BROADCAST:                 MARKETING(),
}

// ─── Ownership scope (COM-1) ────────────────────────────────────────────────────
//
// Separates RegisterDesk PLATFORM lifecycle notifications (wallet, licensing,
// settlement, event review, auth/verification) from ORGANIZER→attendee event
// communications. This is the single ownership axis the Organizer workspace uses
// to decide which templates it may see/manage; Admin (future) will surface the
// platform-scoped ones. Derived from the existing audience `group` so there is
// ONE source of truth and NO duplicate registry.

export type NotificationScope = 'organizer' | 'platform'

export function notificationScope(type: NotificationType): NotificationScope {
  return NOTIFICATION_META[type]?.group === 'platform' ? 'platform' : 'organizer'
}

/** True when a notification type is an organizer-managed attendee communication. */
export function isOrganizerNotification(type: NotificationType): boolean {
  return notificationScope(type) === 'organizer'
}

// Reserved catalog names from the target architecture that have NO active
// dispatch path yet (Phase G1.0 confirmed these are not sent as emails today).
// Declared for documentation/forward-reference only — wiring them is a future
// phase and must not be faked here.
export const RESERVED_NOTIFICATION_TYPES = [
  'PAYMENT_SUCCESS',
  'SETTLEMENT_READY',
  'REMINDER',
  'PUSH_TEST',
] as const

// ─── Compile-time integrity: payload map ⇔ catalog must stay in lockstep ───────
type _CatalogHasPayload = NotificationType extends keyof NotificationPayloadMap ? true : never
type _PayloadHasCatalog = keyof NotificationPayloadMap extends NotificationType ? true : never
const _assertCatalog: _CatalogHasPayload = true
const _assertPayload: _PayloadHasCatalog = true
void _assertCatalog
void _assertPayload
