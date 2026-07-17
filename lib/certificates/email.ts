// Certificate email delivery — server-only.
// The single path for sending a certificate by email, reused by auto-send
// (Phase 5 engine), manual send/resend, and bulk jobs (Phase 7). It goes through
// the existing RegisterDesk Email Service (EmailProvider) — never directly to a
// provider SDK — so swapping Resend ↔ SES requires no change here.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { safeFetchBytes, validateGeneratedCertificateUrl } from './urlGuard'
import { getSettings, recordCertificateEmail } from './firestore'
import { replaceVariables }  from './placeholders'
import { defaultCertificateSettings } from './types'
import { APP_URL } from '@/lib/env'
import type { Certificate } from './types'
import type { PlaceholderContext } from './placeholders'

export interface EmailCertificateResult {
  success: boolean
  skipped: boolean        // already emailed and not forced
  error?:  string
  messageId?: string
}

const DEFAULT_SUBJECT = 'Your Certificate - {{eventName}}'
const DEFAULT_MESSAGE =
  'Hi {{participantName}},\n\n' +
  'Your certificate for {{eventName}} is attached and ready to download. ' +
  'You can verify its authenticity any time using the link below.\n\n' +
  'Certificate ID: {{certificateId}}'

async function fetchPdfBase64(url: string): Promise<string | null> {
  // SSRF-guarded: the certificate file must be a generated cert in our Storage.
  const bytes = await safeFetchBytes(url, validateGeneratedCertificateUrl(url)).catch(() => null)
  return bytes ? Buffer.from(bytes).toString('base64') : null
}

/**
 * Sends (or resends) a certificate email and records the result on the
 * certificate. Idempotent by default: if the certificate was already emailed and
 * `force` is not set, it is skipped. Best-effort — never throws; the boolean
 * result reflects success.
 */
export async function emailCertificate(
  certificate: Certificate,
  opts: { pdfBytes?: Uint8Array; force?: boolean } = {},
): Promise<EmailCertificateResult> {
  const { pdfBytes, force = false } = opts

  // Idempotency — don't re-send an already-delivered certificate unless forced.
  if (!force && (certificate.emailStatus === 'sent' || certificate.emailStatus === 'delivered')) {
    return { success: true, skipped: true }
  }

  const to = certificate.attendeeEmail
  if (!to) return { success: false, skipped: false, error: 'No recipient email' }

  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return { success: false, skipped: false, error: 'Email is not configured' }

  // Resolve subject + message from settings (placeholder-aware), falling back to
  // sensible defaults. The stored placeholder snapshot IS the resolution context.
  const settings = await getSettings(certificate.eventId)
  const auto     = settings?.autoEmail ?? defaultCertificateSettings().autoEmail
  const context  = certificate.data as PlaceholderContext

  const subject = replaceVariables(auto.subject?.trim() || DEFAULT_SUBJECT, context)
  const message = replaceVariables(auto.message?.trim() || DEFAULT_MESSAGE, context)

  const verifyUrl   = `${APP_URL}/verify/certificate/${certificate.certificateId}`
  // Include the verification token so the recipient's download works even when
  // settings.download.requireVerification is enabled.
  const downloadUrl = certificate.verificationToken
    ? `${APP_URL}/api/certificates/${certificate.certificateId}/file?token=${encodeURIComponent(certificate.verificationToken)}`
    : `${APP_URL}/api/certificates/${certificate.certificateId}/file`

  // Attach the generated PDF — reuse in-memory bytes when available, else fetch.
  let pdfBase64: string | null = null
  if (pdfBytes) {
    pdfBase64 = Buffer.from(pdfBytes).toString('base64')
  } else if (certificate.fileUrl) {
    pdfBase64 = await fetchPdfBase64(certificate.fileUrl)
  }

  const result = await notificationEngine.send(NotificationType.CERTIFICATE_READY, {
    to,
    attendeeName:  certificate.attendeeName,
    eventName:     certificate.eventName,
    certificateId: certificate.certificateId,
    downloadUrl,
    verifyUrl,
    subject,
    message,
    pdf: pdfBase64
      ? { filename: `certificate-${certificate.certificateId}.pdf`, contentBase64: pdfBase64 }
      : undefined,
  })

  const status = result.success ? 'sent' : 'failed'
  await recordCertificateEmail(
    certificate.certificateId,
    {
      recipient: to,
      provider:  'ses',
      status,
      timestamp: new Date().toISOString(),
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(result.error ? { error: result.error } : {}),
    },
    status,
  ).catch(() => { /* tracking failure is non-fatal */ })

  return {
    success:   result.success,
    skipped:   false,
    error:     result.error,
    messageId: result.messageId,
  }
}
