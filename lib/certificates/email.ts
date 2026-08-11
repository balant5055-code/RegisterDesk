// Certificate email delivery — server-only.
// The single path for sending a certificate by email, reused by auto-send
// (Phase 5 engine), manual send/resend, and bulk jobs (Phase 7). It goes through
// the existing RegisterDesk Email Service (EmailProvider) — never directly to a
// provider SDK — so swapping Resend ↔ SES requires no change here.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { getSettings, recordCertificateEmail } from './firestore'
import { replaceVariables }  from './placeholders'
import { defaultCertificateSettings } from './types'
import { getEmailAppUrl } from '@/lib/email/appUrl'
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

/**
 * Sends (or resends) a certificate email and records the result on the
 * certificate. Idempotent by default: if the certificate was already emailed and
 * `force` is not set, it is skipped. Best-effort — never throws; the boolean
 * result reflects success.
 */
export async function emailCertificate(
  certificate: Certificate,
  /** `pdfBytes` is still ACCEPTED so the generation path needn't change, but it is no
   *  longer attached — the mail links to the on-demand download instead. */
  opts: { pdfBytes?: Uint8Array; force?: boolean } = {},
): Promise<EmailCertificateResult> {
  const { force = false } = opts

  // Idempotency — don't re-send an already-delivered certificate unless forced.
  if (!force && (certificate.emailStatus === 'sent' || certificate.emailStatus === 'delivered')) {
    return { success: true, skipped: true }
  }

  const to = certificate.attendeeEmail
  if (!to) return { success: false, skipped: false, error: 'No recipient email' }

  // RD-EMAIL-PROVIDER — a certificate belongs to an event; gate and send on ITS transport.
  // MUST be eventSlug, never eventId: eventId is the draftId, and the resolver reads
  // events/{slug}. Passing the draftId finds no document and silently falls back to SES,
  // so every certificate for a Resend event left through the wrong transport.
  // (`certificate.eventId` remains correct just below for certificateSettings/{eventId}.)
  const emailProviderName = await resolveEventEmailProvider(certificate.eventSlug)
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL, emailProviderName)) return { success: false, skipped: false, error: 'Email is not configured' }

  // Resolve subject + message from settings (placeholder-aware), falling back to
  // sensible defaults. The stored placeholder snapshot IS the resolution context.
  const settings = await getSettings(certificate.eventId)
  const auto     = settings?.autoEmail ?? defaultCertificateSettings().autoEmail
  const context  = certificate.data as PlaceholderContext

  const subject = replaceVariables(auto.subject?.trim() || DEFAULT_SUBJECT, context)
  const message = replaceVariables(auto.message?.trim() || DEFAULT_MESSAGE, context)

  // ── Absolute links ─────────────────────────────────────────────────────────
  // getEmailAppUrl() THROWS in production when NEXT_PUBLIC_APP_URL is a local origin —
  // deliberately, so dead links never reach a recipient. But this function is documented
  // (and relied upon) as best-effort/never-throws, and the calling route has no try/catch
  // around it: an uncaught throw here surfaced to the operator as a bare "Request failed
  // (500)" with no history row, because the throw happened BEFORE recordCertificateEmail.
  //
  // The refusal is still absolute — the mail is not sent — but it is now a RECORDED,
  // explained failure instead of a crash.
  let verifyUrl: string
  let downloadUrl: string
  try {
    const base  = getEmailAppUrl()
    verifyUrl   = `${base}/verify/certificate/${certificate.certificateId}`
    // Include the verification token so the recipient's download works even when
    // settings.download.requireVerification is enabled.
    downloadUrl = certificate.verificationToken
      ? `${base}/api/certificates/${certificate.certificateId}/file?token=${encodeURIComponent(certificate.verificationToken)}`
      : `${base}/api/certificates/${certificate.certificateId}/file`
  } catch (err) {
    const reason = err instanceof Error && err.name === 'LocalEmailUrlError'
      ? 'Email links are misconfigured for this deployment (NEXT_PUBLIC_APP_URL points at a local address). The certificate was not emailed.'
      : 'Could not build the certificate links. The certificate was not emailed.'
    console.error('[certificate-email] url_build_failed', {
      certificateId: certificate.certificateId,
      eventId:       certificate.eventId,
      reason:        err instanceof Error ? err.name : 'unknown',
    })
    await recordCertificateEmail(
      certificate.certificateId,
      { recipient: to, provider: emailProviderName, status: 'failed',
        timestamp: new Date().toISOString(), error: reason },
      'failed',
    ).catch(() => { /* tracking failure is non-fatal */ })
    return { success: false, skipped: false, error: reason }
  }

  // NO PDF ATTACHMENT. The certificate is now rendered on demand at the download link, so
  // attaching it here would re-download the artifact per recipient and ship a multi-MB
  // base64 payload to the provider for every one of them — at event scale that is tens of
  // GB of egress against a 15s per-attempt send timeout, and the single largest cause of
  // certificate-email failure. The mail carries `downloadUrl` (token-bearing, honours the
  // organizer's download settings) and `verifyUrl`, which is strictly more capable than a
  // static attachment: it always serves the current certificate and can be revoked.
  const pdfBase64: string | null = null

  // RD-EMAIL-PROVIDER — certificates belong to an event, so they follow its provider.
  // Certificate GENERATION and the PDF attachment are untouched; only the transport moves.
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
  }, emailProviderName)

  const status = result.success ? 'sent' : 'failed'
  await recordCertificateEmail(
    certificate.certificateId,
    {
      recipient: to,
      provider:  emailProviderName,
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
