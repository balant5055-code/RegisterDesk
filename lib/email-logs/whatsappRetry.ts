// RD-WA-LOGS-01 · MANUAL WhatsApp retry for a failed attendee registration confirmation.
//
// ═══ WHY THIS IS A SEPARATE CALL SITE ════════════════════════════════════════
// `sendWhatsAppConfirmation` is the LIVE registration path: fire-and-forget, returns void,
// and swallows every error because the registration and its email have already succeeded.
// An HTTP retry needs the opposite contract — it must report exactly why a send failed so
// the organizer sees the real Meta reason. Rather than change the live path's signature,
// this module composes the SAME primitives (Meta provider, template registry, wallet
// ledger) behind a result-returning contract. The live path is untouched.
//
// ═══ WHAT IS NOT DUPLICATED ══════════════════════════════════════════════════
// Nothing about registrations, payments or pricing. This reads an EXISTING registration by
// id and never writes one. The wallet debit reuses the SAME deterministic ledger id the
// live path uses — `whatsapp_{registrationId}` — so a retry can never double-charge a
// registration whose first attempt already succeeded and billed.
//
// ═══ MONEY RULES, ENFORCED HERE ══════════════════════════════════════════════
//   • A failed Meta send is NEVER charged — the debit happens strictly after success.
//   • A successful send charges EXACTLY once, guarded by the deterministic ledger doc.
//   • An already-sent registration is refused before the provider is called at all.
//
// Concurrency is handled by the caller (the route claims the log row transactionally,
// flipping failed → queued) — this module assumes it holds that claim.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { getWalletBalance, txnDeductWallet } from '@/lib/firebase/firestore/wallet'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { validatePhoneNumber } from '@/lib/communication/phone'
import type { OrganizerWallet } from '@/types/events'
import type { RegistrationDocument } from '@/lib/registrations/types'

/** The template this retry supports. Anything else is refused by the route. */
export const RETRYABLE_WHATSAPP_TEMPLATE_KEY = 'registration_confirmation'

export type WhatsAppRetryResult =
  | {
      ok: true
      messageId?: string
      /** Paise actually debited for THIS attempt. 0 when free or already billed. */
      costPaise: number
      recipient: string
    }
  | {
      ok: false
      /** Machine-readable outcome, mapped to an HTTP status by the route. */
      reason:
        | 'not_configured' | 'channel_disabled' | 'event_disabled'
        | 'registration_missing' | 'already_sent' | 'no_phone'
        | 'insufficient_balance' | 'template_unresolved' | 'send_failed'
      /** Normalized, organizer-safe message. Never contains credentials. */
      error: string
      /** Meta Graph error code, when the failure came from the provider. */
      code?: number
      httpStatus?: number
      /** Compact diagnostics in the same shape the live path logs. */
      providerResponse?: string
    }

export interface WhatsAppRetryArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
}

/**
 * Wallet debit — byte-for-byte the same rules as the live confirmation path.
 *
 * The ledger id is deterministic PER REGISTRATION, not per attempt. That is deliberate:
 * "charge exactly once for this registration's WhatsApp confirmation" is the billing
 * contract, so a retry after a previously-billed success is a no-op rather than a second
 * charge. Returns what was actually debited so the caller can report it honestly.
 */
async function deductWhatsAppCharge(args: WhatsAppRetryArgs, costPaise: number): Promise<number> {
  const walletRef = adminDb.doc(`organizerWallets/${args.organizerUid}`)
  const ledgerRef = adminDb.collection('walletTransactions').doc(`whatsapp_${args.registrationId}`)
  const walletCfg = await getWalletConfig()

  const debited = await adminDb.runTransaction(async (txn) => {
    const ledgerSnap = await txn.get(ledgerRef)
    if (ledgerSnap.exists) return 0   // already charged for this registration — idempotent

    const walletSnap = await txn.get(walletRef)
    const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    const newBalance = balance - costPaise
    // Re-check inside the txn: the caller's pre-check is a TOCTOU with concurrent charges.
    // The message is already sent, so on insufficient funds the platform absorbs it rather
    // than driving the wallet negative.
    if (!walletCfg.allowNegativeBalance && balance < costPaise) return 0

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
    return costPaise
  })

  if (debited > 0) {
    void adminDb.collection('communicationUsage').add({
      organizerUid: args.organizerUid,
      eventId:      args.eventSlug,
      eventSlug:    args.eventSlug,
      eventName:    args.eventName,
      channel:      'whatsapp',
      quantity:     1,
      costPaise:    debited,
      campaignId:   '',
      templateKey:  RETRYABLE_WHATSAPP_TEMPLATE_KEY,
      createdAt:    FieldValue.serverTimestamp(),
    }).catch(() => { /* usage log is best-effort */ })
  }
  return debited
}

/** Mirrors the live path's registration-doc bookkeeping (whatsappStatus / …SentAt / …). */
function recordStatus(
  registrationId: string,
  status: NonNullable<RegistrationDocument['whatsappStatus']>,
  extra?: { messageId?: string; reason?: string },
): void {
  const patch: Record<string, unknown> = { whatsappStatus: status }
  if (status === 'sent') {
    patch.whatsappSentAt = FieldValue.serverTimestamp()
    if (extra?.messageId) patch.whatsappMessageId = extra.messageId
  } else if (extra?.reason) {
    patch.whatsappFailureReason = extra.reason
  }
  adminDb.collection('registrations').doc(registrationId).update(patch)
    .catch(err => console.error(`[whatsapp-retry] status persist failed for ${registrationId}:`, err))
}

/**
 * Re-send one attendee registration confirmation over WhatsApp.
 *
 * Reads an existing registration; writes no registration and no payment. Unlike the live
 * path this RETURNS the outcome so the API can surface the exact Meta reason.
 */
export async function retryWhatsAppConfirmation(args: WhatsAppRetryArgs): Promise<WhatsAppRetryResult> {
  const provider = await getMetaProvider()
  if (!provider) {
    return { ok: false, reason: 'not_configured', error: 'WhatsApp is not configured on this deployment.' }
  }

  const comm = await getCommunicationConfig()
  if (!comm.whatsapp.enabled) {
    return { ok: false, reason: 'channel_disabled', error: 'WhatsApp messaging is disabled in Business Configuration.' }
  }

  const [eventSnap, regSnap] = await Promise.all([
    adminDb.collection('events').doc(args.eventSlug).get(),
    adminDb.collection('registrations').doc(args.registrationId).get(),
  ])

  const pricing = eventSnap.exists
    ? (eventSnap.data() as { pricing?: { whatsappEnabled?: boolean } }).pricing
    : undefined
  if (!pricing?.whatsappEnabled) {
    return { ok: false, reason: 'event_disabled', error: 'WhatsApp is not enabled for this event.' }
  }

  if (!regSnap.exists) {
    return { ok: false, reason: 'registration_missing', error: 'Registration not found.' }
  }
  const reg = regSnap.data() as RegistrationDocument

  // The same idempotency guard the live path applies — checked BEFORE the provider is
  // called, so an already-delivered confirmation can never be sent twice.
  if (reg.whatsappStatus === 'sent') {
    return { ok: false, reason: 'already_sent', error: 'This WhatsApp confirmation was already delivered.' }
  }

  const phone = reg.attendee.phone?.trim()
  if (!phone) {
    return { ok: false, reason: 'no_phone', error: 'This registration has no attendee phone number.' }
  }
  const phoneCheck = validatePhoneNumber(phone)
  if (!phoneCheck.valid) {
    return { ok: false, reason: 'no_phone', error: `Invalid phone number: ${phoneCheck.reason}` }
  }
  const normalizedPhone = phoneCheck.normalizedPhone as string

  const costPaise = comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0
  const walletCfg = await getWalletConfig()
  const balance   = await getWalletBalance(args.organizerUid)
  if (!walletCfg.allowNegativeBalance && costPaise > 0 && balance < costPaise) {
    return { ok: false, reason: 'insufficient_balance', error: 'Insufficient wallet balance to send this message.' }
  }

  const resolved = resolveWhatsAppTemplate(
    NotificationType.REGISTRATION_CONFIRMATION,
    normalizedPhone,
    {
      attendeeName: reg.attendee.name,
      eventName:    args.eventName,
      ticketCode:   reg.ticketCode ?? '',
    },
  )
  if (!resolved.ok) {
    recordStatus(args.registrationId, 'failed', { reason: resolved.error })
    return { ok: false, reason: 'template_unresolved', error: resolved.error }
  }

  const result = await provider.sendTemplate(resolved.message)
  if (!result.success) {
    // NOT charged. Same compact diagnostic string the live path stores, built only from
    // httpStatus / code / providerMessage — no credential ever reaches it.
    const providerResponse =
      `HTTP ${result.httpStatus ?? '-'} · code ${result.code ?? '-'} · ${result.providerMessage ?? result.error ?? 'unknown'}`
    const error = result.error ?? 'WhatsApp send failed'
    recordStatus(args.registrationId, 'failed', { reason: error })
    return {
      ok: false, reason: 'send_failed', error,
      code: result.code, httpStatus: result.httpStatus, providerResponse,
    }
  }

  // Success → charge (idempotent) and mark the registration delivered.
  const debited = costPaise > 0 ? await deductWhatsAppCharge(args, costPaise) : 0
  recordStatus(args.registrationId, 'sent', { messageId: result.messageId })

  return { ok: true, messageId: result.messageId, costPaise: debited, recipient: normalizedPhone }
}
