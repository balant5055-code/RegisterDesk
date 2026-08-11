// Attendee MSG91 SMS registration confirmation.
//
// ADDITIVE. Invoked fire-and-forget from sendConfirmationEmail AFTER the confirmation
// email, exactly where sendWhatsAppConfirmation is invoked and for the same reasons:
// the registration and payment are already durably committed by then, and this function
// is contracted never to throw. Nothing about registration, payment, email or WhatsApp
// behaviour changes — this only adds a channel.
//
// Failure rules, enforced here:
//   • no/invalid phone   → skipped, status 'skipped_no_phone', registration unaffected
//   • MSG91 unconfigured → skipped silently (a deployment without credentials behaves
//                          exactly as it did before SMS existed)
//   • send fails         → status 'failed' + logged; NOTHING about the registration or
//                          the payment is touched
//   • already sent       → skipped (idempotency guard below)
//
// There is no email/SES fallback of any kind: SMS failing means no SMS, never a
// substitute message on another channel.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { writeEmailLog } from '@/lib/email-logs/write'
import { normalizePhoneNumber, validatePhoneNumber } from '@/lib/communication/phone'
import { sendMsg91Sms, isMsg91Configured } from '@/lib/sms/msg91'

export interface RegistrationSmsArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  attendeeEmail:  string
  ticketUrl:      string
  /** Optional override. Omitted ⇒ read from the registration document, which keeps
   *  every existing caller's signature untouched. */
  attendeePhone?: string
}

export type RegistrationSmsStatus = 'sent' | 'failed' | 'skipped_no_phone' | 'skipped_not_configured'

/** Last 4 digits only — the existing WhatsApp/comms logs keep the full number in the
 *  log document (organizer-visible) but console output stays masked. */
const mask = (p: string) => (p.length > 4 ? `••••••${p.slice(-4)}` : '••••')

function recordStatus(registrationId: string, status: RegistrationSmsStatus, reason?: string): void {
  const patch: Record<string, unknown> = { smsStatus: status }
  if (status === 'sent') patch.smsSentAt = FieldValue.serverTimestamp()
  else if (reason)       patch.smsFailureReason = reason
  // Only ever writes sms* fields. Registration status, paymentStatus, amount, paymentId
  // and refundId are never in this patch.
  adminDb.collection('registrations').doc(registrationId).update(patch)
    .catch(err => console.error(`[sms] status persist failed for ${registrationId}:`, err))
}

function logComm(
  args:   RegistrationSmsArgs,
  phone:  string,
  status: 'sent' | 'failed' | 'skipped',
  extra?: { messageId?: string; error?: string; providerResponse?: string },
): void {
  void writeEmailLog({
    organizerUid:   args.organizerUid,
    eventId:        args.eventSlug,
    eventSlug:      args.eventSlug,
    eventName:      args.eventName,
    templateKey:    'registration_confirmation',
    recipientEmail: args.attendeeEmail,
    recipientName:  args.attendeeName,
    subject:        `SMS: Registration confirmation — ${args.eventName}`,
    status,
    provider:       'msg91',
    channel:        'sms',
    recipientPhone: phone,
    costPaise:      0,
    providerMessageId: extra?.messageId,
    providerResponse:  extra?.providerResponse,
    error:             extra?.error,
    registrationId: args.registrationId,
  })
}

/**
 * Sends the registration-confirmation SMS. NEVER throws.
 *
 * Idempotency: a transactional compare-and-set on `smsStatus` claims the send, so the
 * four paths that converge on a confirmed registration — submit, verify-payment, the
 * Razorpay webhook and the reconciliation sweep — can each call this and only the first
 * one actually sends. `force` exists for a deliberate operator resend.
 */
export async function sendRegistrationSms(
  args: RegistrationSmsArgs,
  opts: { force?: boolean } = {},
): Promise<RegistrationSmsStatus> {
  try {
    // Unconfigured ⇒ behave exactly as before SMS existed. Checked first so an
    // unconfigured deployment writes no status and no log rows at all.
    if (!isMsg91Configured()) return 'skipped_not_configured'

    // `attendee.phone` is the canonical attendee mobile (lib/registrations/types.ts:49).
    // Read here rather than threaded through ConfirmationEmailArgs so no existing caller
    // signature changes. The stored value is never modified.
    const raw = (args.attendeePhone
      ?? (await adminDb.collection('registrations').doc(args.registrationId).get()
            .then(s => (s.data() as { attendee?: { phone?: string } } | undefined)?.attendee?.phone)
            .catch(() => undefined)
         )
    )?.trim() ?? ''

    if (!raw) {
      recordStatus(args.registrationId, 'skipped_no_phone', 'No mobile number on the registration')
      logComm(args, '', 'skipped', { error: 'No mobile number on the registration' })
      return 'skipped_no_phone'
    }

    // ONE canonical normalizer, shared with WhatsApp. Idempotent, so 9876543210,
    // 919876543210 and +919876543210 all resolve to 919876543210 — never +91+91.
    const check = validatePhoneNumber(raw)
    if (!check.valid || !check.normalizedPhone) {
      const reason = check.reason ?? 'Invalid mobile number'
      recordStatus(args.registrationId, 'skipped_no_phone', reason)
      logComm(args, normalizePhoneNumber(raw), 'skipped', { error: reason })
      return 'skipped_no_phone'
    }
    const phone = check.normalizedPhone

    // ── Idempotency claim ────────────────────────────────────────────────────
    // Transactional so two converging paths cannot both pass the check. Only a
    // terminal 'sent' blocks; a previous failure/skip may be retried.
    if (!opts.force) {
      const ref = adminDb.collection('registrations').doc(args.registrationId)
      const claimed = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(ref)
        if (!snap.exists) return false
        if ((snap.data() as { smsStatus?: string }).smsStatus === 'sent') return false
        tx.update(ref, { smsStatus: 'sending' })
        return true
      }).catch(() => false)          // a claim failure must never break the caller
      if (!claimed) return 'sent'    // someone else already sent it
    }

    const result = await sendMsg91Sms(phone, {
      // Variable NAMES must match the approved DLT template exactly. These are the
      // conventional MSG91 flow variables; see the report for what to confirm.
      name:    args.attendeeName,
      event:   args.eventName,
      regid:   args.registrationId,
      url:     args.ticketUrl,
    })

    if (result.success) {
      recordStatus(args.registrationId, 'sent')
      logComm(args, phone, 'sent', { messageId: result.messageId })
      return 'sent'
    }

    // Failed. The registration and payment are already committed and are NOT touched.
    console.error(`[sms] confirmation failed for ${args.registrationId} (${mask(phone)}):`, result.error)
    recordStatus(args.registrationId, 'failed', result.error)
    logComm(args, phone, 'failed', { error: result.error, providerResponse: result.errorDetail })
    return 'failed'
  } catch (err) {
    // Belt and braces: this function is contracted never to throw into its caller.
    console.error(`[sms] unexpected error for ${args.registrationId}:`, err)
    return 'failed'
  }
}
