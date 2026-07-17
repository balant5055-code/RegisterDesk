// Server-only — never import from client components or pages.
// All email sending must go through the EmailProvider interface so that
// swapping providers (Resend → SES → SendGrid) requires only a provider
// implementation change and zero business-logic changes.

export type EmailStatus = 'pending' | 'sent' | 'failed'

// ─── OTP / Auth email params ──────────────────────────────────────────────────

export interface OtpEmailParams {
  to:   string
  name: string    // used for personalised salutation
  code: string    // 6-digit plain-text code — sent only to the verified recipient
}

export interface WelcomeEmailParams {
  to:      string
  name:    string
  orgName: string
}

// ─── Parameter types ──────────────────────────────────────────────────────────

export interface RegistrationEmailParams {
  to:             string
  attendeeName:   string
  eventName:      string
  eventDate:      string    // pre-formatted, e.g. "Saturday, 15 March 2026"
  eventTime?:     string    // e.g. "09:30"
  venueName?:     string
  venueCity?:     string
  ticketCode:     string
  passName:       string
  registrationId: string
  ticketPageUrl:  string    // absolute URL to /tickets/{registrationId}
  pdfDownloadUrl: string    // absolute URL to /api/tickets/{registrationId}/pdf?token=...
  receiptDownloadUrl?: string  // absolute URL to /api/receipts/{registrationId}?token=... (paid only)
  /** Raw ICS text — when present, attached as calendar-invite.ics in the email. */
  icsContent?:    string
}

// Ticket re-delivery email — same shape as registration confirmation
export type TicketEmailParams = RegistrationEmailParams

export interface EventCancelledEmailParams {
  to:            string
  attendeeName:  string
  eventName:     string
  eventDate:     string
  cancelReason?: string
}

export interface EventUpdatedEmailParams {
  to:           string
  attendeeName: string
  eventName:    string
  changes:      string[]   // human-readable descriptions, e.g. ["Date moved to 20 March"]
  eventPageUrl: string
}

export interface CertificateEmailParams {
  to:            string
  attendeeName:  string
  eventName:     string
  certificateId: string
  downloadUrl:   string   // absolute URL to download the certificate PDF
  verifyUrl:     string   // absolute URL to verify on public page
  /** Overrides the default subject (already placeholder-resolved). */
  subject?:      string
  /** Organizer custom body text (already placeholder-resolved, plain text). */
  message?:      string
  /** Generated certificate PDF to attach. */
  pdf?: {
    filename:      string
    contentBase64: string
  }
}

// ─── Result ───────────────────────────────────────────────────────────────────

export interface EmailResult {
  success:    boolean
  messageId?: string
  // Client-safe, normalized reason (e.g. "Email rejected by SES"). SAFE to return
  // in an API response — never contains raw provider/AWS internals.
  error?:     string
  // Full provider diagnostic (SES exception name · message · code · requestId ·
  // httpStatusCode). SERVER-ONLY: intended for server logs and the Communication
  // Log (emailLogs) — MUST NOT be returned to a client.
  errorDetail?: string
}

// ─── Registration lifecycle email params ──────────────────────────────────────

export interface RegistrationRejectedEmailParams {
  to:           string
  attendeeName: string
  eventName:    string
  ticketCode:   string
  reason?:      string
}

export interface RegistrationCancelledEmailParams {
  to:           string
  attendeeName: string
  eventName:    string
  ticketCode:   string
  reason?:      string
}

export interface RefundConfirmationEmailParams {
  to:           string
  attendeeName: string
  eventName:    string
  ticketCode:   string
  passName:     string
  refundAmount: number   // paise
  refundId:     string
}

// ─── Waitlist email params ────────────────────────────────────────────────────

export interface WaitlistJoinedEmailParams {
  to:          string
  attendeeName: string
  eventName:   string
  passName:    string
  eventPageUrl: string
}

export interface SpotAvailableEmailParams {
  to:           string
  attendeeName: string
  eventName:    string
  passName:     string
  registerUrl:  string   // URL for the attendee to complete registration
}

// ─── Donation receipt email params ───────────────────────────────────────────

export interface DonationReceiptEmailParams {
  to:            string
  donorName:     string
  donorEmail:    string
  campaignTitle: string
  organizerName: string
  amountRupees:  number
  receiptNumber: string
  transactionId: string
  paidAt:        string    // pre-formatted, e.g. "15 January 2026"
  receiptUrl:    string    // absolute URL to the receipt page
  downloadUrl:   string    // absolute URL to the PDF download
}

export interface Donation80GEmailParams extends DonationReceiptEmailParams {
  organizerPan:   string
  reg80GNumber:   string
  certValidUntil: string   // pre-formatted expiry date
}

// ─── Payout profile notification email params ────────────────────────────────

export interface PayoutProfileVerifiedEmailParams {
  to:               string
  organizerName:    string
  accountHolderName: string
  payoutMethod:     'bank' | 'upi'
}

export interface PayoutProfileRejectedEmailParams {
  to:               string
  organizerName:    string
  accountHolderName: string
  rejectionNote?:   string
}

// ─── Settlement notification email params ────────────────────────────────────

export interface SettlementApprovedEmailParams {
  to:            string
  organizerName: string
  amountPaise:   number
  requestedAt:   string   // ISO 8601
}

export interface SettlementRejectedEmailParams {
  to:            string
  organizerName: string
  amountPaise:   number
  adminNote?:    string
}

export interface SettlementPaidEmailParams {
  to:             string
  organizerName:  string
  amountPaise:    number
  utrNumber:      string
  bankReference?: string
  paidAt:         string  // ISO 8601
}

// ─── Custom / broadcast email params ─────────────────────────────────────────

export interface CustomEmailParams {
  to:      string
  subject: string
  html:    string  // full HTML document (shell already applied)
  // Optional white-label sender display name. The verified sending ADDRESS is
  // never changed; only the From display name is overridden (e.g. "Acme Events").
  fromName?: string
  // Optional extra SMTP headers (e.g. List-Unsubscribe / List-Unsubscribe-Post
  // for bulk-sender one-click compliance). Forwarded verbatim to the provider.
  headers?: Record<string, string>
}

// ─── Application email params ─────────────────────────────────────────────────

export interface ApplicationReceivedEmailParams {
  to:              string
  applicantName:   string
  eventName:       string
  applicationType: 'speaker' | 'sponsor'
  eventUrl:        string
}

export interface ApplicationStatusEmailParams {
  to:              string
  applicantName:   string
  eventName:       string
  applicationType: 'speaker' | 'sponsor'
  status:          'approved' | 'rejected'
  eventUrl:        string
  note?:           string
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface EmailProvider {
  // Auth & onboarding
  sendOtpEmail(params: OtpEmailParams):         Promise<EmailResult>
  sendWelcomeEmail(params: WelcomeEmailParams): Promise<EmailResult>

  // Attendee transactional
  sendRegistrationEmail(params: RegistrationEmailParams):               Promise<EmailResult>
  sendTicketEmail(params: TicketEmailParams):                           Promise<EmailResult>
  sendEventCancelledEmail(params: EventCancelledEmailParams):           Promise<EmailResult>
  sendEventUpdatedEmail(params: EventUpdatedEmailParams):               Promise<EmailResult>
  sendCertificateEmail(params: CertificateEmailParams):                 Promise<EmailResult>
  sendRegistrationRejectedEmail(params: RegistrationRejectedEmailParams):   Promise<EmailResult>
  sendRegistrationCancelledEmail(params: RegistrationCancelledEmailParams): Promise<EmailResult>
  sendRefundConfirmationEmail(params: RefundConfirmationEmailParams):       Promise<EmailResult>
  sendWaitlistJoinedEmail(params: WaitlistJoinedEmailParams):               Promise<EmailResult>
  sendSpotAvailableEmail(params: SpotAvailableEmailParams):                 Promise<EmailResult>

  // Donation receipts
  sendDonationReceiptEmail(params: DonationReceiptEmailParams): Promise<EmailResult>
  sendDonation80GEmail(params: Donation80GEmailParams):         Promise<EmailResult>

  // Speaker / Sponsor applications
  sendApplicationReceivedEmail(params: ApplicationReceivedEmailParams): Promise<EmailResult>
  sendApplicationStatusEmail(params: ApplicationStatusEmailParams):     Promise<EmailResult>

  // Settlement notifications (organizer-facing)
  sendSettlementApprovedEmail(params: SettlementApprovedEmailParams): Promise<EmailResult>
  sendSettlementRejectedEmail(params: SettlementRejectedEmailParams): Promise<EmailResult>
  sendSettlementPaidEmail(params: SettlementPaidEmailParams):         Promise<EmailResult>

  // Payout profile notifications (organizer-facing)
  sendPayoutProfileVerifiedEmail(params: PayoutProfileVerifiedEmailParams): Promise<EmailResult>
  sendPayoutProfileRejectedEmail(params: PayoutProfileRejectedEmailParams): Promise<EmailResult>

  // Broadcast / custom HTML
  sendCustomEmail(params: CustomEmailParams): Promise<EmailResult>
}
