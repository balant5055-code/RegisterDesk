// Email dispatch registry — maps each NotificationType to the concrete provider
// call that fulfils it. This is the ONLY module that knows which EmailProvider
// method / template a notification type resolves to. Business code never does.
//
// The mapped-type signature makes this table EXHAUSTIVE: adding a NotificationType
// without wiring a dispatcher here is a compile error, and each dispatcher is
// type-checked against that type's payload.

import type { EmailProvider, EmailResult } from '@/lib/email/provider'
import type { NotificationType, NotificationPayloadMap } from './catalog'
import { renderReviewEmail } from './templates/review'
import { renderLicensePurchasedEmail, renderWalletRechargedEmail } from './templates/organizer'

export type EmailDispatcher<T extends NotificationType> = (
  provider: EmailProvider,
  payload:  NotificationPayloadMap[T],
) => Promise<EmailResult>

export const EMAIL_DISPATCHERS: { [T in NotificationType]: EmailDispatcher<T> } = {
  // Auth & onboarding
  EMAIL_VERIFICATION:        (p, x) => p.sendOtpEmail(x),
  ACCOUNT_WELCOME:           (p, x) => p.sendWelcomeEmail(x),

  // Event review — template owned by the engine (renderReviewEmail)
  EVENT_SUBMITTED:           (p, x) => p.sendCustomEmail(renderReviewEmail('submitted', x)),
  EVENT_APPROVED:            (p, x) => p.sendCustomEmail(renderReviewEmail('approved', x)),
  EVENT_REJECTED:            (p, x) => p.sendCustomEmail(renderReviewEmail('rejected', x)),
  EVENT_CHANGES_REQUESTED:   (p, x) => p.sendCustomEmail(renderReviewEmail('changes_requested', x)),
  EVENT_RESUBMITTED:         (p, x) => p.sendCustomEmail(renderReviewEmail('resubmitted', x)),

  // Registration lifecycle
  REGISTRATION_CONFIRMATION: (p, x) => p.sendRegistrationEmail(x),
  REGISTRATION_APPROVED:     (p, x) => p.sendRegistrationEmail(x),
  REGISTRATION_REJECTED:     (p, x) => p.sendRegistrationRejectedEmail(x),
  REGISTRATION_CANCELLED:    (p, x) => p.sendRegistrationCancelledEmail(x),
  TICKET_RESENT:             (p, x) => p.sendTicketEmail(x),
  EVENT_CANCELLED:           (p, x) => p.sendEventCancelledEmail(x),
  EVENT_UPDATED:             (p, x) => p.sendEventUpdatedEmail(x),
  REFUND_SUCCESS:            (p, x) => p.sendRefundConfirmationEmail(x),
  WAITLIST_JOINED:           (p, x) => p.sendWaitlistJoinedEmail(x),
  WAITLIST_SPOT_AVAILABLE:   (p, x) => p.sendSpotAvailableEmail(x),
  CERTIFICATE_READY:         (p, x) => p.sendCertificateEmail(x),

  // Donations
  DONATION_RECEIPT:          (p, x) => p.sendDonationReceiptEmail(x),
  DONATION_80G_RECEIPT:      (p, x) => p.sendDonation80GEmail(x),

  // Applications
  APPLICATION_RECEIVED:      (p, x) => p.sendApplicationReceivedEmail(x),
  APPLICATION_STATUS:        (p, x) => p.sendApplicationStatusEmail(x),

  // Settlement & payout
  SETTLEMENT_APPROVED:       (p, x) => p.sendSettlementApprovedEmail(x),
  SETTLEMENT_REJECTED:       (p, x) => p.sendSettlementRejectedEmail(x),
  SETTLEMENT_PAID:           (p, x) => p.sendSettlementPaidEmail(x),
  PAYOUT_PROFILE_VERIFIED:   (p, x) => p.sendPayoutProfileVerifiedEmail(x),
  PAYOUT_PROFILE_REJECTED:   (p, x) => p.sendPayoutProfileRejectedEmail(x),

  // Billing lifecycle — engine-owned templates rendered to custom HTML
  LICENSE_PURCHASED:         (p, x) => p.sendCustomEmail(renderLicensePurchasedEmail(x)),
  WALLET_RECHARGED:          (p, x) => p.sendCustomEmail(renderWalletRechargedEmail(x)),

  // Marketing / free-form
  CUSTOM_EMAIL:              (p, x) => p.sendCustomEmail(x),
  BROADCAST:                 (p, x) => p.sendCustomEmail(x),
}
