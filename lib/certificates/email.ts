// Certificate email delivery — server-only.
// The single path for sending a certificate by email, reused by auto-send
// (Phase 5 engine), manual send/resend, and bulk jobs (Phase 7). It goes through
// the existing RegisterDesk Email Service (EmailProvider) — never directly to a
// provider SDK — so swapping Resend ↔ SES requires no change here.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { captureError } from '@/lib/monitoring/sentry'
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
  /**
   * Why nothing was sent, when nothing was sent.
   *
   * The bulk worker has to tell three outcomes apart — delivered, deliberately skipped, and
   * withheld pending review — and it used to do that by matching on `error` prose. A
   * discriminant makes the distinction structural, so rewording a message cannot silently
   * reclassify a certificate. Absent on a real send and on a real failure.
   */
  reason?: 'already_sent' | 'busy' | 'needs_review' | 'not_failed' | 'not_found'
}

const DEFAULT_SUBJECT = 'Your Certificate - {{eventName}}'
// RD-CERT-EMAIL-02 — the copy must match what the recipient is actually given. Nothing is
// attached any more: the mail carries a link to the Certificate Center, where the attendee
// identifies themselves, adds a photo if the template needs one, and downloads the
// personalised render. Saying "attached" here would describe a mail that no longer exists.
const DEFAULT_MESSAGE =
  'Hi {{participantName}},\n\n' +
  'Your certificate for {{eventName}} is ready. Click below to verify your details, ' +
  'upload your photo, and download your certificate.\n\n' +
  'Certificate ID: {{certificateId}}'

/**
 * Sends (or resends) a certificate email and records the result on the
 * certificate. Idempotent by default: if the certificate was already emailed and
 * `force` is not set, it is skipped. Best-effort — never throws; the boolean
 * result reflects success.
 *
 * ═══ THIS FUNCTION IS THE SINGLE OWNER OF THE CLAIM ══════════════════════════
 * No caller may claim a certificate before calling it. The bulk worker used to, and because
 * `claimCertificateEmail` has no re-entrancy — no holder token, by design, so that two
 * senders can never both proceed — the claim taken here saw the caller's own claim, returned
 * `busy`, and every bulk send became a skip that the job counted as a success. Delivery
 * reported N sent with the provider never called. If a caller needs the claimed document,
 * it comes back inside this function; it must not be claimed outside it.
 */
export async function emailCertificate(
  certificate: Certificate,
  opts: { force?: boolean; intent?: EmailClaimIntent } = {},
): Promise<EmailCertificateResult> {
  const { force = false } = opts
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
        return { success: true, skipped: true, reason: 'already_sent' }
      case 'busy':
        return { success: true, skipped: true, error: 'Another delivery is in progress', reason: 'busy' }
      case 'needs_review':
        return { success: false, skipped: true, error: 'A previous delivery attempt did not complete. This certificate needs review before it is sent again.', reason: 'needs_review' }
      case 'not_failed':
        return { success: true, skipped: true, reason: 'not_failed' }
      default:
        return { success: false, skipped: false, error: 'Certificate not found', reason: 'not_found' }
    }
  }
  // Send against the document as it was CLAIMED, not the caller's copy.
  certificate = claim.certificate

  // ═══ EVERY EXIT FROM HERE ON MUST RELEASE THE CLAIM ════════════════════════
  //
  // The claim above set `emailStatus: 'processing'` with a lease. Reaching a terminal status
  // is what ENDS that claim (recordCertificateEmail clears the lease), so any path that
  // leaves without recording strands the certificate: it stays `processing`, the lease
  // lapses, and it becomes `needs_review` — which every automatic intent is refused. One
  // unrecorded early return therefore makes a certificate permanently unsendable.
  //
  // That was not hypothetical. The `Email is not configured` return below did exactly this,
  // and a throw from resolveEventEmailProvider, getSettings, replaceVariables or the provider
  // send did the same by escaping the function entirely — despite this function being
  // documented, and relied upon, as never throwing.
  //
  // So the whole post-claim body is guarded and every failure goes through `failClaimed`,
  // which records `failed` — a RETRYABLE status the claim accepts again. `needs_review` is
  // unaffected: it is decided by the CLAIM above, only when a previous attempt's outcome is
  // genuinely unknowable, and is never reached from here.
  let providerLabel = 'unknown'

  /** Records a terminal failure, releasing the claim. `failed` is retryable by design. */
  const failClaimed = async (reason: string, tag: string): Promise<EmailCertificateResult> => {
    console.error(`[certificate-email] ${tag}`, {
      certificateId: certificate.certificateId,
      eventId:       certificate.eventId,
    })
    await recordCertificateEmail(
      certificate.certificateId,
      { recipient: to, provider: providerLabel, status: 'failed',
        timestamp: new Date().toISOString(), error: reason },
      'failed',
    ).catch(() => { /* tracking failure is non-fatal */ })
    return { success: false, skipped: false, error: reason }
  }

  try {
    // RD-EMAIL-PROVIDER — a certificate belongs to an event; gate and send on ITS transport.
    //
    // eventSLUG, not eventId. `resolveEventEmailProvider` reads `events/{slug}`, and a
    // certificate's `eventId` is the DRAFT id — so this looked up a document that cannot
    // exist, the resolver's "absent value" path returned the SES default, and EVERY
    // certificate email left through SES no matter which provider an admin had selected for
    // the event. The organizer then saw a truthful "Email rejected by SES" on an event
    // configured for Resend: the message was never hardcoded, the routing was wrong.
    //
    // Note the deliberate trap below: `getSettings` IS keyed by the draft id. The two
    // identifiers are not interchangeable, and only this call wants the slug.
    const emailProviderName = await resolveEventEmailProvider(certificate.eventSlug)
    providerLabel = emailProviderName

    if (!notificationEngine.isAvailable(NotificationChannel.EMAIL, emailProviderName)) {
      return await failClaimed(
        'Email is not configured for this event. The certificate was not emailed.',
        'provider_unavailable',
      )
    }

    // Resolve subject + message from settings (placeholder-aware), falling back to
    // sensible defaults. The stored placeholder snapshot IS the resolution context.
    const settings = await getSettings(certificate.eventId)
    const auto     = settings?.autoEmail ?? defaultCertificateSettings().autoEmail
    const context  = certificate.data as PlaceholderContext

    const subject = replaceVariables(auto.subject?.trim() || DEFAULT_SUBJECT, context)
    const message = replaceVariables(auto.message?.trim() || DEFAULT_MESSAGE, context)

    // ── Absolute links ───────────────────────────────────────────────────────
    // getEmailAppUrl() THROWS in production when NEXT_PUBLIC_APP_URL is a local origin —
    // deliberately, so dead links never reach a recipient. The refusal stays absolute; it is
    // simply a RECORDED, explained failure rather than a crash.
    let verifyUrl: string
    let certificateCenterUrl: string
    try {
      const base  = getEmailAppUrl()

      // PRESERVED. The authenticity link is not part of the obsolete direct-download flow:
      // it resolves a PUBLIC verification page by certificate id and carries no credential,
      // so it stays exactly as it was.
      verifyUrl   = `${base}/verify/certificate/${certificate.certificateId}`

      // RD-CERT-EMAIL-01 — the EVENT CERTIFICATE CENTER, not a direct file link.
      //
      // This previously built `/api/certificates/{id}/file?token=<verificationToken>`. Two
      // problems with that, one product and one security:
      //
      //   · It SKIPPED the Center, which is where certificate search and photo upload/
      //     verification live. An attendee whose certificate needs a photo had no way to add
      //     one — the emailed link handed them the un-personalised artifact instead.
      //   · It put the PERMANENT `verificationToken` in an email. That is a 192-bit bearer
      //     credential with no expiry (see lib/certificates/id.ts); forwarding the mail hands
      //     over unrevocable download rights. The Center mints a SHORT-LIVED capability after
      //     an identity lookup, so a forwarded link is worth nothing.
      //
      // Built exactly as `lib/certificates/whatsapp.ts` builds it — same canonical
      // `getEmailAppUrl()`, same path — so the two channels can no longer disagree about what
      // a certificate link is. No second URL builder and no hardcoded host.
      //
      // `eventSlug`, NOT `certificateId`: the Center is an event surface that then finds the
      // attendee's certificates. A certificateId here would 404 for every recipient.
      certificateCenterUrl = `${base}/events/${certificate.eventSlug}/certificates`
    } catch (err) {
      return await failClaimed(
        err instanceof Error && err.name === 'LocalEmailUrlError'
          ? 'Email links are misconfigured for this deployment (NEXT_PUBLIC_APP_URL points at a local address). The certificate was not emailed.'
          : 'Could not build the certificate links. The certificate was not emailed.',
        'url_build_failed',
      )
    }

    // ── NO ATTACHMENT, DELIBERATELY ──────────────────────────────────────────
    //
    // RD-CERT-EMAIL-02. This used to resolve the stored artifact (pdfBytes → fileKey →
    // fileUrl) and attach it. That artifact is the NON-PERSONALISED render: an attendee
    // photo is applied at request time by /api/certificates/[id]/file/personalized and is
    // never written back to storage. So on any photo-enabled template the attachment was a
    // certificate missing the very photo the attendee is being asked to upload — a wrong
    // document delivered as a success, which also removed any reason to visit the Center.
    //
    // The mail is now CTA-only. That deletes the whole storage round-trip from the send path
    // (no download, no base64, no multi-megabyte provider payload per recipient) and with it
    // the `artifact_unavailable` failure mode. Generic email attachments elsewhere are
    // untouched — only this one template stopped using them.
    const result = await notificationEngine.send(NotificationType.CERTIFICATE_READY, {
      to,
      attendeeName:  certificate.attendeeName,
      eventName:     certificate.eventName,
      certificateId: certificate.certificateId,
      eventSlug:     certificate.eventSlug,
      certificateCenterUrl,
      verifyUrl,
      subject,
      message,
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
  } catch (err) {
    // The backstop. Anything unexpected between the claim and the record lands here, so the
    // certificate is released as `failed` (retryable) rather than stranded in `processing`.
    captureError(err, {
      scope: 'certificate_email', area: 'certificate',
      certificateId: certificate.certificateId,
    })
    return await failClaimed(
      'The certificate could not be emailed because of an unexpected error. It can be retried.',
      'unexpected_failure',
    )
  }
}
