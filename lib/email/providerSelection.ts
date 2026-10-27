// RD-EMAIL-PROVIDER-04 · Selecting the platform email provider, and reporting provider status.
// SERVER-ONLY (reads environment presence — never returns a secret value).
//
// One refusal rule, used by BOTH write paths (the Communication Center route and the generic
// Business Configuration route), so a provider without credentials cannot become the platform
// (The transport factory is imported LAZILY: the generic config route must not load the whole
// email stack — and Firebase Admin — just to save an unrelated section.)
// provider by any door. Status reports PRESENCE and identity (sender address / display name /
// region) only; API keys, secrets and webhook secrets are never read into a response.

import { isEmailProviderName, type EmailProviderName } from './providerName'
import {
  AWS_REGION, SES_FROM_EMAIL, SES_FROM_NAME, SES_SNS_TOPIC_ARNS,
  RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME, RESEND_WEBHOOK_SECRET,
} from '@/lib/env'

export const EMAIL_PROVIDER_LABEL: Record<EmailProviderName, string> = { ses: 'Amazon SES', resend: 'Resend' }

/** Why this value cannot be selected as the platform provider, or null when it can. */
export async function emailProviderSelectionRefusal(value: unknown): Promise<string | null> {
  if (!isEmailProviderName(value)) return 'Choose Amazon SES or Resend.'
  const { getEmailProvider } = await import('./index')
  if (getEmailProvider(value) === null) {
    return value === 'resend'
      ? 'Resend is not configured on this server (RESEND_API_KEY and RESEND_FROM_EMAIL are required). Nothing was changed.'
      : 'Amazon SES is not configured on this server (SES_FROM_EMAIL and credentials are required). Nothing was changed.'
  }
  return null
}

export interface EmailProviderStatus {
  name:       EmailProviderName
  label:      string
  /** The transport can be built: required settings are present. NOT a verified live connection. */
  configured: boolean
  fromEmail:  string | null
  fromName:   string | null
  /** Settings that are missing, by NAME (never their values). */
  missing:    string[]
  /** Bounce / complaint feedback wiring present (SES: SNS topic allow-list; Resend: webhook secret). */
  feedbackConfigured: boolean
  region?:    string
}

export async function emailProviderStatuses(): Promise<EmailProviderStatus[]> {
  const { getEmailProvider } = await import('./index')
  const ses: EmailProviderStatus = {
    name: 'ses', label: EMAIL_PROVIDER_LABEL.ses,
    configured: getEmailProvider('ses') !== null,
    fromEmail: SES_FROM_EMAIL || null, fromName: SES_FROM_NAME || 'RegisterDesk',
    missing: [...(!SES_FROM_EMAIL ? ['SES_FROM_EMAIL'] : [])],
    feedbackConfigured: Boolean(SES_SNS_TOPIC_ARNS),
    region: AWS_REGION,
  }
  const resend: EmailProviderStatus = {
    name: 'resend', label: EMAIL_PROVIDER_LABEL.resend,
    configured: getEmailProvider('resend') !== null,
    fromEmail: RESEND_FROM_EMAIL || null, fromName: RESEND_FROM_NAME || 'RegisterDesk',
    missing: [...(!RESEND_API_KEY ? ['RESEND_API_KEY'] : []), ...(!RESEND_FROM_EMAIL ? ['RESEND_FROM_EMAIL'] : [])],
    feedbackConfigured: Boolean(RESEND_WEBHOOK_SECRET),
  }
  return [ses, resend]
}
