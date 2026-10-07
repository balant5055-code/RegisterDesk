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
import { getWalletBalance } from '@/lib/firebase/firestore/wallet'
import { reserveServiceUnits, releaseServiceUnits, draftIdForEventSlug, type ReserveOutcome } from '@/lib/licensing/serviceAllowanceLedger'
import { callbackDataFor, recordMessageAcceptance, withPersistRetry, unknownLogId } from '@/lib/whatsapp/acceptance'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
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
  attendeeName: string; email: string; phone: string; wamid: string; fromAllowance: boolean; source: 'send' | 'webhook'
  allowanceDraftId?: string | null
}) {
  const unitKey = `wa_cert_${a.certificateId}`
  const comm = await getCommunicationConfig()
  const costPaise = a.fromAllowance ? 0 : (comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0)
  return withPersistRetry(() => recordMessageAcceptance({
    organizerUid: a.organizerUid, eventSlug: a.eventSlug, eventName: a.eventName, wamid: a.wamid,
    templateKey: 'certificate_ready', costPaise,
    baseLedgerId: `cert_whatsapp_${a.certificateId}`, ledgerReferenceId: a.certificateId,
    ledgerDescription: `Certificate WhatsApp — ${a.eventName}`,
    ledgerMetadata: { certificateId: a.certificateId, registrationId: a.registrationId },
    log: {
      organizerUid: a.organizerUid, eventId: a.eventSlug, eventSlug: a.eventSlug, eventName: a.eventName,
      templateKey: 'certificate_ready', recipientEmail: a.email, recipientName: a.attendeeName,
      subject: `WhatsApp: Certificate ready — ${a.eventName}`, status: 'sent', provider: 'meta', channel: 'whatsapp',
      recipientPhone: a.phone, registrationId: a.registrationId,
    },
    ...(a.fromAllowance && a.allowanceDraftId ? { allowanceUnit: { draftId: a.allowanceDraftId, unitKey } } : {}),
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
    const unitKey = `wa_cert_${args.certificateId}`
    let allowance: ReserveOutcome = { mode: 'none' }
    if (allowanceDraftId) {
      allowance = await reserveServiceUnits({ draftId: allowanceDraftId, service: 'whatsapp', unitKey, source: 'certificate_ready' })
      if (allowance.mode === 'exhausted' && allowance.policy === 'block') {
        logSkip(email, normalizedPhone, 'Prepaid WhatsApp allowance used up — while the event is open, buy more on the event Wallet')
        return
      }
    }
    const fromAllowance = allowance.mode === 'allowance'
    // RD-INTEG — release only a unit THIS call took (a concurrent duplicate may hold it).
    const giveBack = () => fromAllowance && allowance.mode === 'allowance' && !allowance.already && allowanceDraftId
      ? releaseServiceUnits({ draftId: allowanceDraftId, service: 'whatsapp', unitKey }).catch(err => console.error('[certificate] allowance release failed', err))
      : Promise.resolve()
    releaseOnError = giveBack

    // Wallet policy — same as attendee confirmation: charge only if configured, and
    // never spend below zero when negative balances are disallowed.
    const costPaise = fromAllowance ? 0 : (comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0)
    const wallet    = await getWalletConfig()
    if (costPaise > 0 && !wallet.allowNegativeBalance) {
      const balance = await getWalletBalance(args.organizerUid)
      if (balance < costPaise) {
        // Insufficient wallet — the certificate is already issued; the delivery is skipped and LOGGED.
        logSkip(email, normalizedPhone, 'Insufficient communication wallet balance')
        return
      }
    }

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

    const result = await provider.sendTemplate({ ...resolved.message, callbackData: callbackDataFor({ kind: 'certificate', certificateId: args.certificateId, registrationId: args.registrationId }) })
    if (!result.success) {
      await giveBack()   // not accepted ⇒ nothing consumed (an accepted-marked unit is never released)
      // RD-CLOSE — an UNKNOWN outcome (no HTTP status) gets the deterministic row the acceptance
      // record upgrades if Meta's webhook proves the message accepted; a definite refusal keeps its own.
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
          phone: normalizedPhone, wamid: result.messageId, fromAllowance, source: 'send', allowanceDraftId,
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
