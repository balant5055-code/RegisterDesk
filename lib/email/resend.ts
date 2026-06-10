// Resend provider — uses the Resend REST API via fetch (no SDK dependency).
// Configured via: EMAIL_PROVIDER=resend, RESEND_API_KEY, EMAIL_FROM
//
// EMAIL_FROM must be a verified sender address or domain in your Resend account,
// e.g. "RegisterDesk <noreply@mail.registerdesk.in>"

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
} from './provider'
import { otpTemplate }            from './templates/otp'
import { welcomeTemplate }        from './templates/welcome'
import { registrationTemplate }   from './templates/registration'
import { ticketTemplate }         from './templates/ticket'
import { eventCancelledTemplate } from './templates/cancelled'
import { eventUpdatedTemplate }   from './templates/updated'
import { certificateTemplate }    from './templates/certificate'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

interface ResendResponseOk    { id: string }
interface ResendResponseError { name: string; message: string; statusCode: number }

async function callResend(
  apiKey:  string,
  from:    string,
  to:      string,
  subject: string,
  html:    string,
): Promise<EmailResult> {
  let res: Response
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    })
  } catch (networkErr) {
    return {
      success: false,
      error:   networkErr instanceof Error ? networkErr.message : 'Network error',
    }
  }

  if (res.ok) {
    const body = await res.json() as ResendResponseOk
    return { success: true, messageId: body.id }
  }

  const errBody = await res.json().catch(() => null) as ResendResponseError | null
  return {
    success: false,
    error:   errBody?.message ?? `Resend HTTP ${res.status}`,
  }
}

export class ResendProvider implements EmailProvider {
  private readonly apiKey: string
  private readonly from:   string

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey
    this.from   = from
  }

  async sendOtpEmail(p: OtpEmailParams): Promise<EmailResult> {
    const { subject, html } = otpTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendWelcomeEmail(p: WelcomeEmailParams): Promise<EmailResult> {
    const { subject, html } = welcomeTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendRegistrationEmail(p: RegistrationEmailParams): Promise<EmailResult> {
    const { subject, html } = registrationTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendTicketEmail(p: TicketEmailParams): Promise<EmailResult> {
    const { subject, html } = ticketTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendEventCancelledEmail(p: EventCancelledEmailParams): Promise<EmailResult> {
    const { subject, html } = eventCancelledTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendEventUpdatedEmail(p: EventUpdatedEmailParams): Promise<EmailResult> {
    const { subject, html } = eventUpdatedTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }

  async sendCertificateEmail(p: CertificateEmailParams): Promise<EmailResult> {
    const { subject, html } = certificateTemplate(p)
    return callResend(this.apiKey, this.from, p.to, subject, html)
  }
}
