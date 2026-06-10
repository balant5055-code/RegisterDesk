// Amazon SES provider — placeholder only.
//
// To activate:
//   1. Install @aws-sdk/client-ses
//   2. Configure AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or IAM role)
//   3. Implement each method using SESClient + SendEmailCommand
//   4. Remove the placeholder rejections below
//   5. Set EMAIL_PROVIDER=ses
//
// Business logic (registration flow, templates, routes) requires zero changes
// when switching from Resend to SES — only this file changes.

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

const NOT_IMPLEMENTED = new Error('SES provider not implemented')

export class SESProvider implements EmailProvider {
  sendOtpEmail(_p: OtpEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendWelcomeEmail(_p: WelcomeEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendRegistrationEmail(_p: RegistrationEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendTicketEmail(_p: TicketEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendEventCancelledEmail(_p: EventCancelledEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendEventUpdatedEmail(_p: EventUpdatedEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }

  sendCertificateEmail(_p: CertificateEmailParams): Promise<EmailResult> {
    return Promise.reject(NOT_IMPLEMENTED)
  }
}
