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
}

// ─── Result ───────────────────────────────────────────────────────────────────

export interface EmailResult {
  success:    boolean
  messageId?: string
  error?:     string
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface EmailProvider {
  // Auth & onboarding
  sendOtpEmail(params: OtpEmailParams):         Promise<EmailResult>
  sendWelcomeEmail(params: WelcomeEmailParams): Promise<EmailResult>

  // Attendee transactional
  sendRegistrationEmail(params: RegistrationEmailParams):     Promise<EmailResult>
  sendTicketEmail(params: TicketEmailParams):                 Promise<EmailResult>
  sendEventCancelledEmail(params: EventCancelledEmailParams): Promise<EmailResult>
  sendEventUpdatedEmail(params: EventUpdatedEmailParams):     Promise<EmailResult>
  sendCertificateEmail(params: CertificateEmailParams):       Promise<EmailResult>
}
