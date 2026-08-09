// Resend provider — the SECOND production email transport. Server-only.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Amazon SES remains a fully supported, unchanged production provider. Resend is ADDED
// alongside it so an individual event can be routed to a transport that is not subject to
// the SES sandbox recipient-verification limit. Nothing here replaces or disables SES.
//
// ═══ WHAT IS SHARED, AND WHAT IS NOT ═════════════════════════════════════════
// EVERYTHING except the transport is shared with SESProvider: the same 22-method
// `EmailProvider` interface, the same `./templates/*` (imported verbatim — no HTML or
// subject is rewritten here), the same suppression list, the same normalised `EmailResult`.
// A second template system would guarantee the two providers drift; there is exactly one.
//
// The ONE structural difference is MIME. SES sends raw MIME assembled by hand
// (`buildMime`); Resend takes `attachments[]` and `headers{}` as first-class API fields, so
// this provider passes them through instead of building MIME. The resulting message —
// recipient, subject, HTML, ICS invite, certificate PDF, List-Unsubscribe headers,
// white-label From display name — is equivalent.
//
// Suppression is a PROVIDER-level responsibility in this codebase (SESProvider gates inside
// its own `send`), so it is replicated here rather than lifted into the engine — lifting it
// would change SES behaviour, which this sprint must not do.

import { Resend } from 'resend'
import { isSuppressed } from '@/lib/firebase/firestore/emailSuppressionList'
import type {
  EmailProvider, EmailResult,
  OtpEmailParams, WelcomeEmailParams,
  RegistrationEmailParams, TicketEmailParams,
  EventCancelledEmailParams, EventUpdatedEmailParams,
  CertificateEmailParams, CustomEmailParams,
  RegistrationRejectedEmailParams, RegistrationCancelledEmailParams,
  RefundConfirmationEmailParams, WaitlistJoinedEmailParams, SpotAvailableEmailParams,
  DonationReceiptEmailParams, Donation80GEmailParams,
  ApplicationReceivedEmailParams, ApplicationStatusEmailParams,
  SettlementApprovedEmailParams, SettlementRejectedEmailParams, SettlementPaidEmailParams,
  PayoutProfileVerifiedEmailParams, PayoutProfileRejectedEmailParams,
} from './provider'
import { otpTemplate }                      from './templates/otp'
import { welcomeTemplate }                  from './templates/welcome'
import { registrationTemplate }             from './templates/registration'
import { ticketTemplate }                   from './templates/ticket'
import { eventCancelledTemplate }           from './templates/cancelled'
import { eventUpdatedTemplate }             from './templates/updated'
import { certificateTemplate }              from './templates/certificate'
import { registrationRejectedTemplate }     from './templates/rejected'
import { registrationCancelledTemplate }    from './templates/registration-cancelled'
import { refundConfirmationTemplate }       from './templates/refund'
import { waitlistJoinedTemplate }           from './templates/waitlist-joined'
import { spotAvailableTemplate }            from './templates/spot-available'
import { donationReceiptTemplate }          from './templates/donation-receipt'
import { donation80GTemplate }              from './templates/donation-80g'
import { applicationReceivedTemplate, applicationStatusTemplate } from './templates/application'
import {
  settlementApprovedTemplate,
  settlementRejectedTemplate,
  settlementPaidTemplate,
} from './templates/settlement'
import {
  payoutProfileVerifiedTemplate,
  payoutProfileRejectedTemplate,
} from './templates/payout-profile'

/** Matches the SES client's request timeout so neither provider hangs a send path. */
const RESEND_TIMEOUT_MS = 15_000

interface ResendAttachment {
  filename: string
  /** base64 payload — Resend accepts a base64 string for `content`. */
  content:  string
}

/** RFC 5322 display-name quoting, mirroring SESProvider's `formatFrom`. */
function formatFrom(name: string, email: string): string {
  const safe = name.replace(/[\r\n"]/g, '').trim()
  return safe ? `"${safe}" <${email}>` : email
}

/**
 * Client-safe error label. Mirrors `normalizeSesError`: never leaks provider internals.
 * The full diagnostic goes to `errorDetail` (server-only) and the console.
 */
function normalizeResendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/timeout|abort/i.test(msg))                 return 'Email provider timed out'
  if (/unauthor|forbidden|api[_ -]?key/i.test(msg)) return 'Email provider rejected the credentials'
  if (/rate.?limit|too many/i.test(msg))          return 'Email provider rate limit reached'
  return 'Email rejected by Resend'
}

function formatResendErrorDetail(err: unknown): string {
  if (err instanceof Error) return `${err.name} · ${err.message}`
  return String(err ?? 'unknown_error')
}

export class ResendProvider implements EmailProvider {
  private readonly client:    Resend
  private readonly fromEmail: string
  private readonly fromName:  string

  constructor(client: Resend, fromEmail: string, fromName: string) {
    this.client    = client
    this.fromEmail = fromEmail
    this.fromName  = fromName
  }

  // The single transport primitive every method funnels through — the same shape as
  // SESProvider.send, so the two providers cannot diverge on suppression or result shape.
  private async send(
    to:      string,
    subject: string,
    html:    string,
    opts?: { attachments?: ResendAttachment[]; headers?: Record<string, string>; fromName?: string },
  ): Promise<EmailResult> {
    // THE canonical suppression gate — identical policy to SESProvider, including
    // failing OPEN on infrastructure error: blocking all transactional email (sign-in
    // OTPs included) during a Firestore blip is worse than one send to a suppressed
    // address.
    try {
      if (await isSuppressed(to)) {
        console.warn('[resend] send skipped — recipient suppressed')
        return { success: false, error: 'Recipient is suppressed', suppressed: true }
      }
    } catch (err) {
      console.error('[resend] suppression check failed; sending anyway:',
        err instanceof Error ? err.message : err)
    }

    // White-label overrides the DISPLAY NAME only — the verified sending address is
    // never changed, exactly as SES does.
    const from = formatFrom(opts?.fromName?.trim() || this.fromName, this.fromEmail)

    try {
      const res = await Promise.race([
        this.client.emails.send({
          from,
          to:      [to],
          subject,
          html,
          ...(opts?.headers     ? { headers: opts.headers }         : {}),
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Resend request timeout')), RESEND_TIMEOUT_MS)),
      ])

      // The SDK reports API-level failures in `error` rather than throwing.
      if (res.error) {
        console.error('[resend] send failed', { name: res.error.name, message: res.error.message, recipient: to })
        return {
          success:     false,
          error:       normalizeResendError(new Error(res.error.message)),
          errorDetail: `${res.error.name} · ${res.error.message}`,
        }
      }
      return { success: true, messageId: res.data?.id }
    } catch (err) {
      console.error('[resend] send threw', {
        detail: formatResendErrorDetail(err), recipient: to,
      })
      return {
        success:     false,
        error:       normalizeResendError(err),
        errorDetail: formatResendErrorDetail(err),
      }
    }
  }

  // ─── 22 interface methods · templates reused VERBATIM from ./templates/* ──────

  async sendOtpEmail(p: OtpEmailParams): Promise<EmailResult> {
    const { subject, html } = otpTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendWelcomeEmail(p: WelcomeEmailParams): Promise<EmailResult> {
    const { subject, html } = welcomeTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendRegistrationEmail(p: RegistrationEmailParams): Promise<EmailResult> {
    const { subject, html } = registrationTemplate(p)
    return this.send(p.to, subject, html, { attachments: icsAttachment(p.icsContent) })
  }

  async sendTicketEmail(p: TicketEmailParams): Promise<EmailResult> {
    const { subject, html } = ticketTemplate(p)
    return this.send(p.to, subject, html, { attachments: icsAttachment(p.icsContent) })
  }

  async sendEventCancelledEmail(p: EventCancelledEmailParams): Promise<EmailResult> {
    const { subject, html } = eventCancelledTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendEventUpdatedEmail(p: EventUpdatedEmailParams): Promise<EmailResult> {
    const { subject, html } = eventUpdatedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendCertificateEmail(p: CertificateEmailParams): Promise<EmailResult> {
    const { subject, html } = certificateTemplate(p)
    const attachments = p.pdf
      ? [{ filename: p.pdf.filename, content: p.pdf.contentBase64 }]
      : undefined
    return this.send(p.to, subject, html, { attachments })
  }

  async sendCustomEmail(p: CustomEmailParams): Promise<EmailResult> {
    return this.send(p.to, p.subject, p.html, { headers: p.headers, fromName: p.fromName })
  }

  async sendRegistrationRejectedEmail(p: RegistrationRejectedEmailParams): Promise<EmailResult> {
    const { subject, html } = registrationRejectedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendRegistrationCancelledEmail(p: RegistrationCancelledEmailParams): Promise<EmailResult> {
    const { subject, html } = registrationCancelledTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendRefundConfirmationEmail(p: RefundConfirmationEmailParams): Promise<EmailResult> {
    const { subject, html } = refundConfirmationTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendWaitlistJoinedEmail(p: WaitlistJoinedEmailParams): Promise<EmailResult> {
    const { subject, html } = waitlistJoinedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendSpotAvailableEmail(p: SpotAvailableEmailParams): Promise<EmailResult> {
    const { subject, html } = spotAvailableTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendDonationReceiptEmail(p: DonationReceiptEmailParams): Promise<EmailResult> {
    const { subject, html } = donationReceiptTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendDonation80GEmail(p: Donation80GEmailParams): Promise<EmailResult> {
    const { subject, html } = donation80GTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendApplicationReceivedEmail(p: ApplicationReceivedEmailParams): Promise<EmailResult> {
    const { subject, html } = applicationReceivedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendApplicationStatusEmail(p: ApplicationStatusEmailParams): Promise<EmailResult> {
    const { subject, html } = applicationStatusTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendSettlementApprovedEmail(p: SettlementApprovedEmailParams): Promise<EmailResult> {
    const { subject, html } = settlementApprovedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendSettlementRejectedEmail(p: SettlementRejectedEmailParams): Promise<EmailResult> {
    const { subject, html } = settlementRejectedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendSettlementPaidEmail(p: SettlementPaidEmailParams): Promise<EmailResult> {
    const { subject, html } = settlementPaidTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendPayoutProfileVerifiedEmail(p: PayoutProfileVerifiedEmailParams): Promise<EmailResult> {
    const { subject, html } = payoutProfileVerifiedTemplate(p)
    return this.send(p.to, subject, html)
  }

  async sendPayoutProfileRejectedEmail(p: PayoutProfileRejectedEmailParams): Promise<EmailResult> {
    const { subject, html } = payoutProfileRejectedTemplate(p)
    return this.send(p.to, subject, html)
  }
}

/** ICS calendar invite — same logical attachment SES sends, in Resend's shape. */
function icsAttachment(icsContent?: string): ResendAttachment[] | undefined {
  if (!icsContent) return undefined
  return [{
    filename: 'calendar-invite.ics',
    content:  Buffer.from(icsContent, 'utf8').toString('base64'),
  }]
}
