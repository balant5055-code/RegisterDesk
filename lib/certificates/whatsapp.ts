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

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { getWalletBalance, txnDeductWallet } from '@/lib/firebase/firestore/wallet'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import { captureError } from '@/lib/monitoring/sentry'
import type { OrganizerWallet } from '@/types/events'
import type { RegistrationDocument } from '@/lib/registrations/types'

export interface CertificateWhatsAppArgs {
  certificateId: string
  registrationId: string
  organizerUid:  string
  eventSlug:     string
  attendeeName:  string
  eventName:     string
}

// Idempotent wallet debit for the certificate WhatsApp (deterministic ledger id).
async function deductCertWhatsApp(args: CertificateWhatsAppArgs, costPaise: number): Promise<void> {
  const walletRef = adminDb.doc(`organizerWallets/${args.organizerUid}`)
  const ledgerRef = adminDb.collection('walletTransactions').doc(`cert_whatsapp_${args.certificateId}`)
  const walletCfg = await getWalletConfig()
  await adminDb.runTransaction(async txn => {
    const ledgerSnap = await txn.get(ledgerRef)
    if (ledgerSnap.exists) return   // already charged — idempotent no-op
    const walletSnap = await txn.get(walletRef)
    const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    // RD-PAY-GA-01B — re-check the balance INSIDE the txn (the caller's pre-check is a
    // TOCTOU with concurrent charges). Never drive the wallet negative: the message was
    // already sent best-effort, so on insufficient funds we skip the charge (platform absorbs).
    if (!walletCfg.allowNegativeBalance && balance < costPaise) return
    txnDeductWallet(txn, args.organizerUid, costPaise)
    txn.set(ledgerRef, {
      organizerUid:  args.organizerUid,
      type:          'whatsapp_charge',
      amountPaise:   costPaise,
      balancePaise:  balance - costPaise,
      status:        'completed',
      referenceType: 'communication',
      referenceId:   args.certificateId,
      description:   `Certificate WhatsApp — ${args.eventName}`,
      metadata:      { eventSlug: args.eventSlug, channel: 'whatsapp', certificateId: args.certificateId, units: 1 },
      createdAt:     FieldValue.serverTimestamp(),
    })
  })
}

/**
 * Best-effort certificate WhatsApp delivery. Never throws.
 */
export async function sendCertificateWhatsApp(args: CertificateWhatsAppArgs): Promise<void> {
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
    const pricing = eventSnap.exists
      ? (eventSnap.data() as { pricing?: { whatsappEnabled?: boolean } }).pricing
      : undefined
    if (!pricing?.whatsappEnabled) return
    if (!regSnap.exists) return

    const reg   = regSnap.data() as RegistrationDocument
    const email = reg.attendee.email ?? ''
    const phone = reg.attendee.phone?.trim()
    if (!phone) return
    const phoneCheck = validatePhoneNumber(phone)
    if (!phoneCheck.valid) return
    const normalizedPhone = phoneCheck.normalizedPhone as string

    // Wallet policy — same as attendee confirmation: charge only if configured, and
    // never spend below zero when negative balances are disallowed.
    const costPaise = comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0
    const wallet    = await getWalletConfig()
    if (costPaise > 0 && !wallet.allowNegativeBalance) {
      const balance = await getWalletBalance(args.organizerUid)
      if (balance < costPaise) return   // insufficient — skip silently (cert already issued)
    }

    const resolved = resolveWhatsAppTemplate(
      NotificationType.CERTIFICATE_READY,
      normalizedPhone,
      { attendeeName: args.attendeeName, eventName: args.eventName },
    )
    if (!resolved.ok) return

    const result = await provider.sendTemplate(resolved.message)
    if (!result.success) {
      void writeEmailLog({
        organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug,
        eventName: args.eventName, templateKey: 'certificate_ready', recipientEmail: email,
        recipientName: args.attendeeName, subject: `WhatsApp: Certificate ready — ${args.eventName}`,
        status: 'failed', provider: 'meta', channel: 'whatsapp', recipientPhone: normalizedPhone,
        costPaise: 0, error: result.error ?? 'WhatsApp send failed', registrationId: args.registrationId,
      })
      return
    }

    if (costPaise > 0) await deductCertWhatsApp(args, costPaise)
    void writeEmailLog({
      organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug,
      eventName: args.eventName, templateKey: 'certificate_ready', recipientEmail: email,
      recipientName: args.attendeeName, subject: `WhatsApp: Certificate ready — ${args.eventName}`,
      status: 'sent', provider: 'meta', channel: 'whatsapp', recipientPhone: normalizedPhone,
      costPaise, providerMessageId: result.messageId, registrationId: args.registrationId,
    })
  } catch (err) {
    console.error(`[certificate] WhatsApp delivery error for ${args.certificateId}:`, err)
    captureError(err, { scope: 'certificate_whatsapp', area: 'certificate', certificateId: args.certificateId, registrationId: args.registrationId })
  }
}
