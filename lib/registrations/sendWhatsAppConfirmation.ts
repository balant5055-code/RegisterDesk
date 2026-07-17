// Attendee WhatsApp registration confirmation (Phase G3.4).
//
// The first production use of the WhatsApp provider. Invoked fire-and-forget from
// sendConfirmationEmail AFTER the (always-free) confirmation email. It reuses the
// existing architecture end to end — Template Registry → Meta Provider — and the
// existing wallet ledger; it introduces no new engine behaviour.
//
// Communication policy (G1.0): attendee WhatsApp is PAID (wallet). Email is free
// and already sent by the caller regardless of this function's outcome.
//
// Failure rules — enforced here, never throws (registration already succeeded):
//   • WhatsApp send fails  → wallet NOT deducted, status 'failed' logged.
//   • Wallet has < 1 msg   → WhatsApp skipped, status 'skipped_insufficient_balance'
//                            logged (dashboard warning surface), email already sent.
//   • Wallet is deducted ONLY after a successful send (idempotent ledger id).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { getWalletBalance, txnDeductWallet } from '@/lib/firebase/firestore/wallet'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import type { OrganizerWallet } from '@/types/events'
import type { RegistrationDocument } from './types'

export interface WhatsAppConfirmationArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  attendeeName:   string
  eventName:      string
  ticketCode:     string
}

type WhatsAppStatus = NonNullable<RegistrationDocument['whatsappStatus']>

// Persist the WhatsApp outcome on the registration doc — the notification log +
// registrations-dashboard surface (mirrors emailStatus). Fire-and-forget.
function recordStatus(
  registrationId: string,
  status:  WhatsAppStatus,
  extra?:  { messageId?: string; reason?: string },
): void {
  const patch: Record<string, unknown> = { whatsappStatus: status }
  if (status === 'sent') {
    patch.whatsappSentAt = FieldValue.serverTimestamp()
    if (extra?.messageId) patch.whatsappMessageId = extra.messageId
  } else if (extra?.reason) {
    patch.whatsappFailureReason = extra.reason
  }
  adminDb.collection('registrations').doc(registrationId).update(patch)
    .catch(err => console.error(`[whatsapp] status persist failed for ${registrationId}:`, err))
}

// Unified communication log (emailLogs, channel='whatsapp') — makes attendee
// WhatsApp visible in the Communication Center alongside email. Best-effort.
function logComm(
  args:   WhatsAppConfirmationArgs,
  email:  string,
  phone:  string,
  status: 'sent' | 'failed' | 'skipped',
  extra?: { costPaise?: number; messageId?: string; error?: string; providerResponse?: string },
): void {
  // writeEmailLog (LS2.1) strips undefined keys — safe to pass optional diagnostics.
  void writeEmailLog({
    organizerUid:   args.organizerUid,
    eventId:        args.eventSlug,
    eventSlug:      args.eventSlug,
    eventName:      args.eventName,
    templateKey:    'registration_confirmation',
    recipientEmail: email,
    recipientName:  args.attendeeName,
    subject:        `WhatsApp: Registration confirmation — ${args.eventName}`,
    status,
    provider:       'meta',
    channel:        'whatsapp',
    recipientPhone: phone,
    costPaise:      extra?.costPaise ?? 0,
    providerMessageId: extra?.messageId,
    providerResponse:  extra?.providerResponse,
    error:             extra?.error,
    registrationId: args.registrationId,
  })
}

// Atomic, idempotent wallet debit + immutable ledger entry — mirrors the broadcast
// billing pattern. Deterministic ledger id ⇒ a replayed confirmation never double
// charges. Called ONLY after a confirmed successful send.
async function deductWhatsAppCharge(args: WhatsAppConfirmationArgs, costPaise: number): Promise<void> {
  const walletRef = adminDb.doc(`organizerWallets/${args.organizerUid}`)
  const ledgerRef = adminDb.collection('walletTransactions').doc(`whatsapp_${args.registrationId}`)

  await adminDb.runTransaction(async (txn) => {
    const ledgerSnap = await txn.get(ledgerRef)
    if (ledgerSnap.exists) return   // already charged — idempotent no-op

    const walletSnap = await txn.get(walletRef)
    const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    const newBalance = balance - costPaise

    txnDeductWallet(txn, args.organizerUid, costPaise)
    txn.set(ledgerRef, {
      organizerUid:  args.organizerUid,
      type:          'whatsapp_charge',
      amountPaise:   costPaise,
      balancePaise:  newBalance,
      status:        'completed',
      referenceType: 'communication',
      referenceId:   args.registrationId,
      description:   `WhatsApp confirmation — ${args.eventName}`,
      metadata:      { eventId: args.eventSlug, eventSlug: args.eventSlug, channel: 'whatsapp', units: 1 },
      createdAt:     FieldValue.serverTimestamp(),
    })
  })

  // Usage tracking — reconciles with the ledger (existing communicationUsage collection).
  void adminDb.collection('communicationUsage').add({
    organizerUid: args.organizerUid,
    eventId:      args.eventSlug,
    eventSlug:    args.eventSlug,
    eventName:    args.eventName,
    channel:      'whatsapp',
    quantity:     1,
    costPaise,
    campaignId:   '',
    templateKey:  'registration_confirmation',
    createdAt:    FieldValue.serverTimestamp(),
  }).catch(() => { /* usage log is best-effort */ })
}

/**
 * Send the attendee WhatsApp confirmation, applying the communication policy and
 * wallet charging. Never throws — the registration and its email are already done.
 */
export async function sendWhatsAppConfirmation(args: WhatsAppConfirmationArgs): Promise<void> {
  try {
    // 1. Provider configured? (WhatsApp disabled platform-wide ⇒ nothing to do.)
    const provider = await getMetaProvider()
    if (!provider) return

    // Communication policy (Business Configuration). WhatsApp disabled platform-wide
    // → skip entirely; the price + whether the attendee wallet is charged are also
    // config-driven (the single source of truth).
    const comm = await getCommunicationConfig()
    if (!comm.whatsapp.enabled) return

    // 2. Load the event's WhatsApp toggle + the attendee phone + idempotency guard.
    const [eventSnap, regSnap] = await Promise.all([
      adminDb.collection('events').doc(args.eventSlug).get(),
      adminDb.collection('registrations').doc(args.registrationId).get(),
    ])

    const pricing = eventSnap.exists
      ? (eventSnap.data() as { pricing?: { whatsappEnabled?: boolean } }).pricing
      : undefined
    if (!pricing?.whatsappEnabled) return   // organizer did not enable WhatsApp for this event

    if (!regSnap.exists) return
    const reg = regSnap.data() as RegistrationDocument
    if (reg.whatsappStatus === 'sent') return   // already delivered — idempotent

    const email = reg.attendee.email ?? ''
    const phone = reg.attendee.phone?.trim()
    if (!phone) {
      recordStatus(args.registrationId, 'skipped_no_phone')
      logComm(args, email, '', 'skipped', { error: 'No attendee phone number' })
      return
    }

    // Normalize + validate — an invalid phone must NEVER reach Meta or the wallet.
    const phoneCheck = validatePhoneNumber(phone)
    if (!phoneCheck.valid) {
      recordStatus(args.registrationId, 'skipped_no_phone', { reason: `Invalid phone: ${phoneCheck.reason}` })
      logComm(args, email, phone, 'skipped', { error: `Invalid phone number: ${phoneCheck.reason}` })
      return
    }
    const normalizedPhone = phoneCheck.normalizedPhone as string

    // 3. Communication policy: attendee WhatsApp is paid (unless disabled) — the
    // price and the wallet-charge toggle come from Business Configuration.
    const costPaise = comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0
    const wallet    = await getWalletConfig()
    const balance   = await getWalletBalance(args.organizerUid)
    if (!wallet.allowNegativeBalance && costPaise > 0 && balance < costPaise) {
      // Wallet empty → email already sent, WhatsApp skipped, dashboard warning.
      recordStatus(args.registrationId, 'skipped_insufficient_balance', { reason: 'Insufficient wallet balance' })
      logComm(args, email, phone, 'skipped', { error: 'Insufficient wallet balance' })
      return
    }

    // 4. Resolve the approved template via the registry (normalized recipient).
    const resolved = resolveWhatsAppTemplate(
      NotificationType.REGISTRATION_CONFIRMATION,
      normalizedPhone,
      { attendeeName: args.attendeeName, eventName: args.eventName, ticketCode: args.ticketCode },
    )
    if (!resolved.ok) {
      recordStatus(args.registrationId, 'failed', { reason: resolved.error })
      logComm(args, email, normalizedPhone, 'failed', { error: resolved.error })
      return
    }

    // 5. Send via the Meta provider.
    console.info(
      `[wa-trace][REGISTRATION_CONFIRMATION] STEP 6 POST /messages → Meta` +
      ` · Template=${resolved.message.templateName} · Original=${phone} · Normalized=${normalizedPhone}`,
    )
    const result = await provider.sendTemplate(resolved.message)
    if (!result.success) {
      // WhatsApp failed → wallet NOT deducted, log failure with FULL Meta diagnostics.
      console.warn(
        `[wa-trace][REGISTRATION_CONFIRMATION] Meta response ERROR ✗` +
        ` · httpStatus=${result.httpStatus ?? '-'} · metaErrorCode=${result.code ?? '-'}` +
        ` · metaErrorMessage="${result.error ?? '-'}" · metaRawMessage="${result.providerMessage ?? '-'}"` +
        ` · template=${resolved.message.templateName} · registrationId=${args.registrationId}`,
      )
      const providerResponse = `HTTP ${result.httpStatus ?? '-'} · code ${result.code ?? '-'} · ${result.providerMessage ?? result.error ?? 'unknown'}`
      recordStatus(args.registrationId, 'failed', { reason: result.error ?? 'WhatsApp send failed' })
      logComm(args, email, phone, 'failed', { error: result.error ?? 'WhatsApp send failed', providerResponse })
      return
    }

    // 6. Success → deduct wallet (idempotent, only when there's a charge) + log.
    if (costPaise > 0) await deductWhatsAppCharge(args, costPaise)
    recordStatus(args.registrationId, 'sent', { messageId: result.messageId })
    logComm(args, email, phone, 'sent', { costPaise, messageId: result.messageId })
  } catch (err) {
    // Never let a WhatsApp problem surface to the caller — registration is done.
    console.error(`[whatsapp] confirmation error for ${args.registrationId}:`, err)
    recordStatus(args.registrationId, 'failed', {
      reason: err instanceof Error ? err.message : 'Unknown WhatsApp error',
    })
  }
}
