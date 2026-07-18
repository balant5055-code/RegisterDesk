// Amazon SES provider — the ONLY production email transport.
//
// Uses the AWS SDK v3 SES v2 API (SendEmailCommand). NOT SMTP. Every message is
// assembled as a raw MIME payload so the full feature surface of the previous
// provider is preserved with a single code path:
//   • HTML body (UTF-8)
//   • attachments (ICS calendar invites, certificate PDFs)
//   • custom headers (broadcast List-Unsubscribe one-click)
//   • white-label From display-name override (verified address is never changed)
//
// Templates are reused verbatim from ./templates/* — no HTML or subject is
// rewritten here. Business logic reaches this class only through the Notification
// Engine → EmailProvider interface, so it stays fully provider-agnostic.

import { randomBytes } from 'node:crypto'
import type { SESv2Client } from '@aws-sdk/client-sesv2'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import type {
  EmailProvider,
  EmailResult,
  OtpEmailParams,
  WelcomeEmailParams,
  RegistrationEmailParams,
  TicketEmailParams,
  EventCancelledEmailParams,
  EventUpdatedEmailParams,
  CertificateEmailParams,
  CustomEmailParams,
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

const SES_TIMEOUT_MS = 20_000   // bound the API call so a hang can't stall the send

interface MimeAttachment {
  filename:    string
  contentType: string
  base64:      string   // already base64-encoded content
}

// ─── MIME assembly ─────────────────────────────────────────────────────────────

const isAscii = (s: string): boolean => !/[^\x20-\x7E]/.test(s)

// RFC 2047 encoded-word for header values containing non-ASCII (e.g. “curly”
// quotes in subjects, non-Latin white-label names).
function encodeHeaderWord(s: string): string {
  return isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

// Format a From header: display name (encoded/quoted as needed) + verified address.
function formatFrom(name: string, email: string): string {
  const clean = name.trim()
  if (!clean) return email
  if (!isAscii(clean)) return `${encodeHeaderWord(clean)} <${email}>`
  if (/[(),.:;<>@[\]"\\]/.test(clean)) return `"${clean.replace(/["\\]/g, '')}" <${email}>`
  return `${clean} <${email}>`
}

// Wrap base64 to 76-char lines per RFC 2045.
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

function buildMime(args: {
  from:         string
  to:           string
  subject:      string
  html:         string
  attachments?: MimeAttachment[]
  headers?:     Record<string, string>
}): Uint8Array {
  const { from, to, subject, html, attachments, headers } = args
  const CRLF = '\r\n'

  const topHeaders: string[] = [
    `From: ${from}`,
    // Strip CR/LF so a recipient address can never inject extra headers (BCC /
    // header splitting) — self-defending at the MIME boundary instead of relying on
    // every caller to validate. Subject/From/custom headers are already guarded.
    `To: ${to.replace(/[\r\n]/g, '')}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
  ]
  for (const [k, v] of Object.entries(headers ?? {})) {
    // Header values are provider-controlled (List-Unsubscribe URLs); strip CR/LF
    // defensively to prevent header injection.
    topHeaders.push(`${k}: ${String(v).replace(/[\r\n]/g, '')}`)
  }

  const htmlB64 = wrap76(Buffer.from(html, 'utf8').toString('base64'))

  if (!attachments?.length) {
    const msg = [
      ...topHeaders,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlB64,
      '',
    ].join(CRLF)
    return Buffer.from(msg, 'utf8')
  }

  const boundary = `=_RD_${randomBytes(16).toString('hex')}`
  const parts: string[] = [
    ...topHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
  ]
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(att.base64),
    )
  }
  parts.push(`--${boundary}--`, '')
  return Buffer.from(parts.join(CRLF), 'utf8')
}

// ─── Error normalization (STEP 7 — never leak raw SDK errors) ──────────────────

function normalizeSesError(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err
    ? String((err as { name: unknown }).name)
    : ''
  switch (name) {
    case 'MessageRejected':                    return 'Email rejected by SES'
    case 'MailFromDomainNotVerifiedException': return 'Sender identity not verified in SES'
    case 'AccountSuspendedException':          return 'SES account suspended'
    case 'SendingPausedException':             return 'SES sending is paused'
    case 'ThrottlingException':
    case 'TooManyRequestsException':           return 'SES rate limit exceeded'
    case 'LimitExceededException':             return 'SES sending quota exceeded'
    case 'TimeoutError':
    case 'AbortError':                         return 'Email send timed out'
    case 'BadRequestException':                return 'Invalid email request'
    default:                                   return name ? `Email delivery failed (${name})` : 'Email delivery failed'
  }
}

// Structured view of an AWS SDK v3 (SES v2) exception. Every field is read
// defensively — `Code` and `$metadata` are optional and vary by error type.
interface SesErrorFields {
  name?:           string
  message?:        string
  code?:           string
  requestId?:      string
  httpStatusCode?: number
}

function extractSesError(err: unknown): SesErrorFields {
  const e = (err ?? {}) as {
    name?: unknown; message?: unknown; Code?: unknown
    $metadata?: { requestId?: unknown; httpStatusCode?: unknown }
  }
  return {
    name:           typeof e.name    === 'string' ? e.name    : undefined,
    message:        typeof e.message === 'string' ? e.message : undefined,
    code:           typeof e.Code    === 'string' ? e.Code    : undefined,
    requestId:      typeof e.$metadata?.requestId      === 'string' ? e.$metadata.requestId      : undefined,
    httpStatusCode: typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined,
  }
}

// Compact single-line diagnostic for the Communication Log (emailLogs) / server
// logs. SERVER-ONLY — carries raw provider detail and must never reach a client.
function formatSesErrorDetail(f: SesErrorFields): string {
  const parts = [
    f.name           && `name=${f.name}`,
    f.message        && `message=${f.message}`,
    f.code           && `code=${f.code}`,
    f.requestId      && `requestId=${f.requestId}`,
    f.httpStatusCode !== undefined && `httpStatusCode=${f.httpStatusCode}`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Unknown SES error (no diagnostic fields)'
}

// ─── Provider ──────────────────────────────────────────────────────────────────

export class SESProvider implements EmailProvider {
  private readonly client:    SESv2Client
  private readonly fromEmail:  string
  private readonly fromName:   string

  constructor(client: SESv2Client, fromEmail: string, fromName: string) {
    this.client    = client
    this.fromEmail = fromEmail
    this.fromName  = fromName
  }

  // The single transport primitive every method funnels through.
  private async send(
    to:           string,
    subject:      string,
    html:         string,
    opts?: { attachments?: MimeAttachment[]; headers?: Record<string, string>; fromName?: string },
  ): Promise<EmailResult> {
    const from = formatFrom(opts?.fromName?.trim() || this.fromName, this.fromEmail)
    const raw  = buildMime({ from, to, subject, html, attachments: opts?.attachments, headers: opts?.headers })

    try {
      // Raw content carries the From header itself; omit FromEmailAddress so SES
      // uses it. maxAttempts:1 on the client disables retries (out of scope here).
      const res = await this.client.send(
        new SendEmailCommand({
          Destination: { ToAddresses: [to] },
          Content:     { Raw: { Data: raw } },
        }),
        { abortSignal: AbortSignal.timeout(SES_TIMEOUT_MS) },
      )
      return { success: true, messageId: res.MessageId }
    } catch (err) {
      // Capture the actual AWS SDK exception. Logged to the server console and
      // surfaced via errorDetail (server-only); the client-facing `error` stays
      // the normalized, non-leaking label.
      const fields = extractSesError(err)
      console.error('[ses] SendEmailCommand failed', {
        name:           fields.name,
        message:        fields.message,
        code:           fields.code,
        requestId:      fields.requestId,
        httpStatusCode: fields.httpStatusCode,
        recipient:      to,
      })
      return {
        success:     false,
        error:       normalizeSesError(err),
        errorDetail: formatSesErrorDetail(fields),
      }
    }
  }

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
      ? [{ filename: p.pdf.filename, contentType: 'application/pdf', base64: p.pdf.contentBase64 }]
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

// Build the ICS calendar-invite attachment (parity with the previous provider).
function icsAttachment(icsContent?: string): MimeAttachment[] | undefined {
  if (!icsContent) return undefined
  return [{
    filename:    'calendar-invite.ics',
    contentType: 'text/calendar',
    base64:      Buffer.from(icsContent, 'utf8').toString('base64'),
  }]
}
