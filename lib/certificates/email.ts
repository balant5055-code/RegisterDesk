// Certificate email delivery — server-only.
// The single path for sending a certificate by email, reused by auto-send
// (Phase 5 engine), manual send/resend, and bulk jobs (Phase 7). It goes through
// the existing RegisterDesk Email Service (EmailProvider) — never directly to a
// provider SDK — so swapping Resend ↔ SES requires no change here.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { storage } from '@/features/platform-storage'
import { safeFetchBytes, validateGeneratedCertificateUrl } from './urlGuard'
import { getSettings, recordCertificateEmail, claimCertificateEmail } from './firestore'
import type { EmailClaimIntent } from './firestore'
import { BULK_LEASE_MS as EMAIL_LEASE_MS } from './constants'
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
  opts: { pdfBytes?: Uint8Array; force?: boolean; intent?: EmailClaimIntent } = {},
): Promise<EmailCertificateResult> {
  const { pdfBytes, force = false } = opts
  // `force` is the historical spelling of an operator-initiated resend; both map to the
  // same intent so existing callers keep working unchanged.
  const intent: EmailClaimIntent = opts.intent ?? (force ? 'resend' : 'send')

  const to = certificate.attendeeEmail
  if (!to) return { success: false, skipped: false, error: 'No recipient email' }

  // ── RD-CERT-EMAIL-IDEMPOTENCY · claim BEFORE the provider is called ─────────
  //
  // This replaces an in-memory `emailStatus` comparison that could not serialize two
  // senders and left no trace if the process died after the provider accepted. The claim
  // re-reads the document inside a transaction, so exactly one of any number of concurrent
  // senders — bulk worker, manual resend, a second worker after a lease expiry — proceeds.
  //
  // `needs_review` is deliberately NOT retried: the certificate was claimed, the lease
  // expired, and whether the provider accepted is unknowable from here. Re-sending would
  // risk the duplicate this whole mechanism exists to prevent.
  const claim = await claimCertificateEmail(certificate.certificateId, {
    intent, leaseMs: EMAIL_LEASE_MS,
  })
  if (!claim.ok) {
    switch (claim.reason) {
      case 'already_sent':
        return { success: true, skipped: true }
      case 'busy':
        return { success: true, skipped: true, error: 'Another delivery is in progress' }
      case 'needs_review':
        return { success: false, skipped: true, error: 'A previous delivery attempt did not complete. This certificate needs review before it is sent again.' }
      case 'not_failed':
        return { success: true, skipped: true }
      default:
        return { success: false, skipped: false, error: 'Certificate not found' }
    }
  }
  // Send against the document as it was CLAIMED, not the caller's copy.
  certificate = claim.certificate

  // RD-EMAIL-PROVIDER — a certificate belongs to an event; gate and send on ITS transport.
  const emailProviderName = await resolveEventEmailProvider(certificate.eventId)
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

  // ── Attach the generated PDF ────────────────────────────────────────────────
  //
  // RESOLUTION ORDER: pdfBytes → fileKey → fileUrl. It mirrors lib/certificates/zip.ts
  // and the download route, because `fileKey` is the CANONICAL artifact: regeneration
  // writes the new render to that key and deliberately leaves `fileUrl` in place as
  // provenance, so a regenerated legacy certificate carries both and the Firebase copy
  // is superseded.
  //
  // WHY THE fileKey BRANCH FAILS HARD. Artifact persistence made `fileUrl` null for every
  // new certificate, so a resolver that knew only `pdfBytes` and `fileUrl` silently sent
  // every bulk-generated and every resent certificate with NO attachment — and then
  // recorded `emailStatus: 'sent'`, which the idempotency guard above reads as "already
  // delivered". The miss sealed itself in: only a manual force-resend could correct it.
  //
  // So when an artifact is EXPECTED and cannot be retrieved, nothing is sent and the
  // failure is recorded — exactly as the link-building refusal above does. The
  // certificate stays retryable because `failed` never satisfies that guard.
  //
  // Deliberately NO fallback to `fileUrl` after a `fileKey` miss: that would attach the
  // superseded render, which is a wrong document delivered as a success.
  let pdfBase64: string | null = null
  if (pdfBytes) {
    pdfBase64 = Buffer.from(pdfBytes).toString('base64')
  } else if (certificate.fileKey) {
    // storage.download() applies assertSafeKey, so a malformed or tampered key throws
    // here rather than reaching the provider.
    const got = await storage.download(certificate.fileKey).catch(() => null)
    if (!got) {
      const reason = 'The certificate file could not be retrieved from storage. The certificate was not emailed.'
      console.error('[certificate-email] artifact_unavailable', {
        certificateId: certificate.certificateId,
        eventId:       certificate.eventId,
      })
      await recordCertificateEmail(
        certificate.certificateId,
        { recipient: to, provider: emailProviderName, status: 'failed',
          timestamp: new Date().toISOString(), error: reason },
        'failed',
      ).catch(() => { /* tracking failure is non-fatal */ })
      return { success: false, skipped: false, error: reason }
    }
    pdfBase64 = Buffer.from(got.body).toString('base64')
  } else if (certificate.fileUrl) {
    // LEGACY, unchanged: best-effort. A pre-R2 certificate whose Firebase object has gone
    // still gets its links-only email, exactly as before this fix.
    pdfBase64 = await fetchPdfBase64(certificate.fileUrl)
  }

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
