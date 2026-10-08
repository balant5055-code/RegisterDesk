// Certificate WhatsApp delivery (GA-4 S2). Server-only.
//
// Automatically sends the "certificate ready" WhatsApp message after a certificate
// is generated. It REUSES the existing delivery stack end-to-end — Template Registry
// (certificate_ready) → Meta Provider → wallet ledger — exactly like the attendee
// registration-confirmation path (lib/registrations/sendWhatsAppConfirmation.ts).
// No new provider, template engine, or billing engine is introduced.
//
// Rules (never throws — the certificate is already issued):
//   • WhatsApp disabled platform-wide / for the event, or no attendee phone ⇒ no-op.
//   • Charged only when policy says attendee WhatsApp is wallet-billed; the wallet is
//     debited ONLY after a confirmed send, via a deterministic (idempotent) ledger id.

import { adminDb }     from '@/lib/firebase/admin'
import { FieldValue } from 'firebase-admin/firestore'
import { draftIdForEventSlug } from '@/lib/licensing/serviceAllowanceLedger'
import { callbackDataFor, recordMessageAcceptance, withPersistRetry, unknownLogId } from '@/lib/whatsapp/acceptance'
import { reserveWhatsAppFunding, releaseWhatsAppFunding, certificateHoldLedgerId } from '@/lib/whatsapp/funding'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { WHATSAPP_CAPACITY_REQUIRED } from '@/lib/communications/capacity'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import { getEmailAppUrl } from '@/lib/email/appUrl'
import { captureError } from '@/lib/monitoring/sentry'
import type { RegistrationDocument } from '@/lib/registrations/types'

export interface CertificateWhatsAppArgs {
  certificateId: string
  registrationId: string
  organizerUid:  string
  eventSlug:     string
  attendeeName:  string
  eventName:     string
}

/**
 * RD-CLOSE — the ONE acceptance record for a certificate WhatsApp: charge + usage + log, one
 * idempotent transaction per wamid (lib/whatsapp/acceptance.ts). Shared by the send and by the
 * status-webhook recovery (lib/whatsapp/acceptanceRecovery.ts).
 */
export async function acceptCertificateMessage(a: {
  certificateId: string; registrationId: string; organizerUid: string; eventSlug: string; eventName: string
  attendeeName: string; email: string; phone: string; wamid: string; source: 'send' | 'webhook'
  /** The event's prepaid ledger (owner-checked), or null when it has none. */
  draftId: string | null
}) {
  const unitKey = `wa_cert_${a.certificateId}`
  const comm = await getCommunicationConfig()
  // RD-COMMS-P2-A — settled against the send's FUNDING HOLD (lib/whatsapp/funding.ts); the legacy
  // price applies only to a message that reaches acceptance with no usable hold.
  return withPersistRetry(() => recordMessageAcceptance({
    organizerUid: a.organizerUid, eventSlug: a.eventSlug, eventName: a.eventName, wamid: a.wamid,
    templateKey: 'certificate_ready',
    funding: { draftId: a.draftId, unitKey, holdLedgerId: certificateHoldLedgerId(a.certificateId), legacyPricePaise: comm.whatsapp.pricePaise },
    ledgerReferenceId: a.certificateId,
    ledgerDescription: `Certificate WhatsApp — ${a.eventName}`,
    ledgerMetadata: { certificateId: a.certificateId, registrationId: a.registrationId },
    log: {
      organizerUid: a.organizerUid, eventId: a.eventSlug, eventSlug: a.eventSlug, eventName: a.eventName,
      templateKey: 'certificate_ready', recipientEmail: a.email, recipientName: a.attendeeName,
      subject: `WhatsApp: Certificate ready — ${a.eventName}`, status: 'sent', provider: 'meta', channel: 'whatsapp',
      recipientPhone: a.phone, registrationId: a.registrationId,
    },
    pendingLogId: unknownLogId(unitKey),
    source: a.source,
  }))
}

/**
 * Best-effort certificate WhatsApp delivery. Never throws.
 */
export async function sendCertificateWhatsApp(args: CertificateWhatsAppArgs): Promise<void> {
  // Set once a prepaid unit is reserved, so an unexpected error can hand it back.
  let releaseOnError: () => Promise<unknown> = async () => undefined
  // RD-EVENT-COMMERCE-02 — a skipped delivery is always LOGGED (Communication Center), never silent.
  const logSkip = (email: string, phone: string, reason: string) => void writeEmailLog({
    organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug,
    eventName: args.eventName, templateKey: 'certificate_ready', recipientEmail: email,
    recipientName: args.attendeeName, subject: `WhatsApp: Certificate ready — ${args.eventName}`,
    status: 'skipped', provider: 'meta', channel: 'whatsapp', recipientPhone: phone,
    costPaise: 0, error: reason, registrationId: args.registrationId,
  })
  try {
    const provider = await getMetaProvider()
    if (!provider) return

    const comm = await getCommunicationConfig()
    if (!comm.whatsapp.enabled) return

    // Event must have WhatsApp enabled; attendee phone comes from the registration.
    const [eventSnap, regSnap] = await Promise.all([
      adminDb.collection('events').doc(args.eventSlug).get(),
      adminDb.collection('registrations').doc(args.registrationId).get(),
    ])
    const eventData = eventSnap.exists ? eventSnap.data() as { pricing?: { whatsappEnabled?: boolean }; draftId?: unknown } : undefined
    const pricing = eventData?.pricing
    // RD-INTEG — owner-checked ledger key (draftIdForEventSlug), never the raw events.draftId.
    const allowanceDraftId = typeof eventData?.draftId === 'string' && eventData.draftId ? await draftIdForEventSlug(args.eventSlug) : null
    if (!pricing?.whatsappEnabled) return
    if (!regSnap.exists) return

    const reg   = regSnap.data() as RegistrationDocument
    const email = reg.attendee.email ?? ''
    const phone = reg.attendee.phone?.trim()
    if (!phone) return
    const phoneCheck = validatePhoneNumber(phone)
    if (!phoneCheck.valid) return
    const normalizedPhone = phoneCheck.normalizedPhone as string

    // RD-EVENT-COMMERCE-02 — the event's prepaid WhatsApp allowance first (see
    // lib/registrations/sendWhatsAppConfirmation.ts for the rule): reserve before the send,
    // release if the provider does not accept it.
    // RD-COMMS-P2-A — funded BEFORE the send, atomically (lib/whatsapp/funding.ts): the event's
    // capacity, else the legacy balance while it covers the whole legacy price. Otherwise the
    // delivery is skipped and LOGGED (the certificate itself is already issued).
    const unitKey = `wa_cert_${args.certificateId}`
    const fundingKey = { organizerUid: args.organizerUid, draftId: allowanceDraftId, unitKey, holdLedgerId: certificateHoldLedgerId(args.certificateId) }
    const funding = await reserveWhatsAppFunding({
      ...fundingKey, legacyPricePaise: comm.whatsapp.pricePaise, source: 'certificate_ready',
      ledger: { referenceId: args.certificateId, description: `Certificate WhatsApp — ${args.eventName}`, eventSlug: args.eventSlug, metadata: { certificateId: args.certificateId, registrationId: args.registrationId } },
    })
    if (!funding.ok) {
      if (funding.reason === 'already_held') return   // already sent (or being sent) for this certificate
      logSkip(email, normalizedPhone, WHATSAPP_CAPACITY_REQUIRED)
      return
    }
    // Only THIS call took the hold; an accepted hold is never released.
    const giveBack = () => releaseWhatsAppFunding(fundingKey).catch(err => console.error('[certificate] funding release failed', err))
    releaseOnError = giveBack

    // RD-WA-BROADCAST-02 — the template now carries the attendee's route to their
    // certificate. Built from the SAME helper and shape the broadcast job uses, so a
    // transactional 'certificate ready' and a bulk one link to the identical place.
    const certificateUrl = `${getEmailAppUrl()}/events/${args.eventSlug}/certificates`

    const resolved = resolveWhatsAppTemplate(
      NotificationType.CERTIFICATE_READY,
      normalizedPhone,
      { attendeeName: args.attendeeName, eventName: args.eventName, certificateUrl },
    )
    if (!resolved.ok) { await giveBack(); return }

    // From the provider call on, only a DEFINITE refusal hands the hold back.
    releaseOnError = async () => undefined
    const result = await provider.sendTemplate({ ...resolved.message, callbackData: callbackDataFor({ kind: 'certificate', certificateId: args.certificateId, registrationId: args.registrationId }) })
      .catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : 'transport failure', httpStatus: undefined, code: undefined, providerMessage: undefined, messageId: undefined }))
    if (!result.success) {
      // RD-CLOSE — an UNKNOWN outcome (no HTTP status) gets the deterministic row the acceptance
      // record upgrades if Meta's webhook proves the message accepted; a definite refusal keeps its own.
      // RD-COMMS-P2-A — and an unknown outcome KEEPS its hold (the webhook settles against it).
      if (result.httpStatus !== undefined) await giveBack()
      if (result.httpStatus === undefined) {
        void adminDb.collection('emailLogs').doc(unknownLogId(unitKey)).set({
          organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug, eventName: args.eventName,
          templateKey: 'certificate_ready', recipientEmail: email, recipientName: args.attendeeName,
          subject: `WhatsApp: Certificate ready — ${args.eventName}`, status: 'failed', provider: 'meta', channel: 'whatsapp',
          recipientPhone: normalizedPhone, costPaise: 0, error: result.error ?? 'WhatsApp send failed', deliveryUnknown: true,
          registrationId: args.registrationId, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }).catch(err => console.error('[certificate] unknown-outcome log write failed', err))
        return
      }
      void writeEmailLog({
        organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug,
        eventName: args.eventName, templateKey: 'certificate_ready', recipientEmail: email,
        recipientName: args.attendeeName, subject: `WhatsApp: Certificate ready — ${args.eventName}`,
        status: 'failed', provider: 'meta', channel: 'whatsapp', recipientPhone: normalizedPhone,
        costPaise: 0, error: result.error ?? 'WhatsApp send failed', registrationId: args.registrationId,
        // RD-INTEG — no HTTP status ⇒ Meta never answered: indeterminate, not failed (same rule
        // as the registration confirmation).
        ...(result.httpStatus === undefined ? { deliveryUnknown: true } : {}),
      })
      return
    }

    // Sent: from here a persistence problem must not hand back the consumed unit. ONE acceptance
    // record (charge + usage + log), retried; the status webhook recovers it if every retry fails.
    releaseOnError = async () => undefined
    if (result.messageId) {
      try {
        await acceptCertificateMessage({
          certificateId: args.certificateId, registrationId: args.registrationId, organizerUid: args.organizerUid,
          eventSlug: args.eventSlug, eventName: args.eventName, attendeeName: args.attendeeName, email,
          phone: normalizedPhone, wamid: result.messageId, source: 'send', draftId: allowanceDraftId,
        })
      } catch (err) {
        console.error(`[certificate] acceptance not persisted for ${args.certificateId} — the status webhook will recover it:`, err)
      }
    }
  } catch (err) {
    console.error(`[certificate] WhatsApp delivery error for ${args.certificateId}:`, err)
    await releaseOnError()
    captureError(err, { scope: 'certificate_whatsapp', area: 'certificate', certificateId: args.certificateId, registrationId: args.registrationId })
  }
}
