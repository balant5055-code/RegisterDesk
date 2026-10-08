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
//
// RD-EVENT-COMMERCE-02 — an event with a PREPAID WhatsApp allowance is billed from that
// allowance: one unit is reserved before the send (so concurrent sends can never exceed it) and
// released again if the provider does not accept the message.
//
// RD-COMMS-P1 — a message the event's capacity does not cover (none bought, or used up — the
// stored exhaustion policy no longer matters) may be funded ONLY by the organizer's LEGACY
// communication balance, at the configured legacy per-message price, and only while that balance
// covers it (lib/communications/capacity). Otherwise it is skipped with a recorded status and the
// capacity message — there is no free send and no new pay-as-you-go path.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { WHATSAPP_CAPACITY_REQUIRED } from '@/lib/communications/capacity'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import type { RegistrationDocument } from './types'
import { draftIdForEventSlug } from '@/lib/licensing/serviceAllowanceLedger'
import { reserveWhatsAppFunding, releaseWhatsAppFunding, confirmationHoldLedgerId } from '@/lib/whatsapp/funding'
import { acceptConfirmation } from './whatsappConfirmationAcceptance'
import { callbackDataFor, unknownLogId } from '@/lib/whatsapp/acceptance'

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
  // RD-CLOSE — never DOWNGRADE a recorded send: Meta's status webhook may already have recorded
  // this message as accepted (sent) while our own request was still timing out.
  const ref = adminDb.collection('registrations').doc(registrationId)
  adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    if (!cur.exists) return
    if (status !== 'sent' && (cur.data() as { whatsappStatus?: unknown }).whatsappStatus === 'sent') return
    txn.update(ref, patch)
  }).catch(err => console.error(`[whatsapp] status persist failed for ${registrationId}:`, err))
}

// Unified communication log (emailLogs, channel='whatsapp') — makes attendee
// WhatsApp visible in the Communication Center alongside email. Best-effort.
function logComm(
  args:   WhatsAppConfirmationArgs,
  email:  string,
  phone:  string,
  status: 'sent' | 'failed' | 'skipped',
  extra?: { costPaise?: number; messageId?: string; error?: string; providerResponse?: string; deliveryUnknown?: boolean },
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
    deliveryUnknown:   extra?.deliveryUnknown,
    providerResponse:  extra?.providerResponse,
    error:             extra?.error,
    registrationId: args.registrationId,
  })
}

// RD-CLOSE — the charge, usage record, log row and registration status for an ACCEPTED message are
// written by ONE idempotent transaction (acceptConfirmation → lib/whatsapp/acceptance.ts), retried,
// and replayable from Meta's status webhook. The former separate debit + fire-and-forget usage/log/
// status writes could each fail on their own and turn an accepted message into a free one.

/**
 * Send the attendee WhatsApp confirmation, applying the communication policy and
 * wallet charging. Never throws — the registration and its email are already done.
 */
export async function sendWhatsAppConfirmation(args: WhatsAppConfirmationArgs): Promise<void> {
  // Set once a prepaid unit is reserved, so an unexpected error can hand it back.
  let releaseOnError: () => Promise<unknown> = async () => undefined
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

    const eventData = eventSnap.exists ? eventSnap.data() as { pricing?: { whatsappEnabled?: boolean }; draftId?: unknown } : undefined
    const pricing = eventData?.pricing
    if (!pricing?.whatsappEnabled) return   // organizer did not enable WhatsApp for this event
    // RD-INTEG — the prepaid ledger key through the owner-checked resolver (the same one
    // broadcasts use), never the raw events.draftId: a draft-id collision must not let this
    // event consume another organizer's prepaid units.
    const allowanceDraftId = typeof eventData?.draftId === 'string' && eventData.draftId ? await draftIdForEventSlug(args.eventSlug) : null

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

    // 2b/3. RD-COMMS-P2-A — FUND the message before it is sent, atomically, from exactly one source:
    // the event's WhatsApp capacity, else the LEGACY balance while it covers the whole legacy price
    // (lib/whatsapp/funding.ts). Otherwise it is skipped — never sent free, never below zero.
    const unitKey = `wa_reg_${args.registrationId}`
    const fundingKey = { organizerUid: args.organizerUid, draftId: allowanceDraftId, unitKey, holdLedgerId: confirmationHoldLedgerId(args.registrationId, unitKey) }
    const funding = await reserveWhatsAppFunding({
      ...fundingKey, legacyPricePaise: comm.whatsapp.pricePaise, source: 'registration_confirmation',
      ledger: { referenceId: args.registrationId, description: `WhatsApp confirmation — ${args.eventName}`, eventSlug: args.eventSlug, metadata: { eventId: args.eventSlug, registrationId: args.registrationId } },
    })
    if (!funding.ok) {
      // A concurrent duplicate of this confirmation already holds (or used) this attempt: it sends.
      if (funding.reason === 'already_held') return
      // Email already sent; WhatsApp skipped and LOGGED (dashboard warning surface).
      recordStatus(args.registrationId, 'skipped_allowance_exhausted', { reason: 'WhatsApp capacity required' })
      logComm(args, email, normalizedPhone, 'skipped', { error: WHATSAPP_CAPACITY_REQUIRED })
      return
    }
    const fromAllowance = funding.mode === 'allowance'
    // Only ever called by THIS attempt, which took the hold. A hold Meta accepted is never released.
    const giveBack = () => releaseWhatsAppFunding(fundingKey).catch(err => console.error('[whatsapp] funding release failed', err))
    releaseOnError = giveBack

    // 4. Resolve the approved template via the registry (normalized recipient).
    const resolved = resolveWhatsAppTemplate(
      NotificationType.REGISTRATION_CONFIRMATION,
      normalizedPhone,
      { attendeeName: args.attendeeName, eventName: args.eventName, ticketCode: args.ticketCode },
    )
    if (!resolved.ok) {
      await giveBack()
      recordStatus(args.registrationId, 'failed', { reason: resolved.error })
      logComm(args, email, normalizedPhone, 'failed', { error: resolved.error })
      return
    }

    // 5. Send via the Meta provider.
    console.info(
      `[wa-trace][REGISTRATION_CONFIRMATION] STEP 6 POST /messages → Meta` +
      ` · Template=${resolved.message.templateName} · Original=${phone} · Normalized=${normalizedPhone}`,
    )
    const startedAt = Date.now()
    // From the provider call on, the outcome may be "accepted": nothing may hand the hold back
    // except a DEFINITE refusal below (an unknown outcome keeps it for the webhook to settle).
    releaseOnError = async () => undefined
    // RD-CLOSE — the callback data lets Meta's status webhook recover this acceptance (and its
    // charge) if anything after the provider call fails, including a transport timeout.
    const result = await provider.sendTemplate({ ...resolved.message, callbackData: callbackDataFor({ kind: 'registration', registrationId: args.registrationId, unitKey }) })
      .catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : 'transport failure', httpStatus: undefined, code: undefined, providerMessage: undefined, messageId: undefined }))
    const durationMs = Date.now() - startedAt
    // ═══ OBSERVABILITY ═════════════════════════════════════════════════════════
    // One structured line per attempt so a timeout is diagnosable after the fact: how long we
    // waited before aborting, and whether Meta answered at all. Deliberately carries NO
    // Authorization header, access token, phone number or template body — only the
    // registration id (already the correlation key everywhere else), the outcome, and the
    // wamid when Meta returned one.
    console.info(
      `[wa-obs][REGISTRATION_CONFIRMATION] registrationId=${args.registrationId}` +
      ` · result=${result.success ? 'sent' : (result.httpStatus === undefined ? 'unknown' : 'failed')}` +
      ` · durationMs=${durationMs} · httpStatus=${result.httpStatus ?? 'none'}` +
      ` · wamid=${result.success ? (result.messageId ?? '-') : '-'}`,
    )
    if (!result.success) {
      // WhatsApp failed → wallet NOT deducted, log failure with FULL Meta diagnostics.
      console.warn(
        `[wa-trace][REGISTRATION_CONFIRMATION] Meta response ERROR ✗` +
        ` · httpStatus=${result.httpStatus ?? '-'} · metaErrorCode=${result.code ?? '-'}` +
        ` · metaErrorMessage="${result.error ?? '-'}" · metaRawMessage="${result.providerMessage ?? '-'}"` +
        ` · template=${resolved.message.templateName} · registrationId=${args.registrationId}`,
      )
      const providerResponse = `HTTP ${result.httpStatus ?? '-'} · code ${result.code ?? '-'} · ${result.providerMessage ?? result.error ?? 'unknown'}`

      // ═══ TRANSPORT FAILURE ⇒ UNKNOWN, NOT FAILED ═══════════════════════════════
      // A response Meta actually produced always carries an httpStatus (normalizeMetaError
      // sets it). Its ABSENCE means the request never completed — AbortSignal.timeout fired,
      // or the socket broke — and that abort is purely client-side: it cannot cancel a
      // message Meta may already have accepted and queued, and the wamid we would need to
      // reconcile it only ever arrives in the response we did not get. Delivery is therefore
      // genuinely indeterminate. Recording it as 'failed' is what let the retry path resend and
      // double-message the attendee. Structural test, not string matching, so it cannot drift
      // with Meta error copy.
      const deliveryUnknown = result.httpStatus === undefined
      const reason = deliveryUnknown
        ? `Delivery status unknown — no response from Meta (${result.error ?? 'transport failure'})`
        : (result.error ?? 'WhatsApp send failed')

      // RD-COMMS-P2-A — DEFINITELY refused ⇒ the hold is given back. UNKNOWN ⇒ it is KEPT: Meta may
      // have accepted it, and its status webhook settles that acceptance against this same hold
      // (no second reservation, no free message). An unresolved hold is returned by the sweep later.
      if (!deliveryUnknown) await giveBack()
      // The log row keeps status 'failed' so every existing consumer stays byte-identical;
      // deliveryUnknown is the additive flag the WhatsApp surfaces read.
      if (deliveryUnknown) {
        // RD-CLOSE — the UNKNOWN status and its deterministic log row are written TOGETHER, in one
        // transaction keyed on the registration, and only if Meta's webhook has not already
        // recorded the message as accepted ('sent'). The acceptance record reads the same
        // registration, so the two serialise: whichever lands second sees the other — the
        // webhook upgrades this row in place, or this write steps aside. One row per message.
        const regRef = adminDb.collection('registrations').doc(args.registrationId)
        const logRef = adminDb.collection('emailLogs').doc(unknownLogId(unitKey))
        await adminDb.runTransaction(async txn => {
          const cur = await txn.get(regRef)
          if (cur.exists && (cur.data() as { whatsappStatus?: unknown }).whatsappStatus === 'sent') return
          if (cur.exists) txn.update(regRef, { whatsappStatus: 'unknown', whatsappFailureReason: reason })
          txn.set(logRef, {
            organizerUid: args.organizerUid, eventId: args.eventSlug, eventSlug: args.eventSlug, eventName: args.eventName,
            templateKey: 'registration_confirmation', recipientEmail: email, recipientName: args.attendeeName,
            subject: `WhatsApp: Registration confirmation — ${args.eventName}`, status: 'failed', provider: 'meta', channel: 'whatsapp',
            recipientPhone: phone, costPaise: 0, error: reason, providerResponse, deliveryUnknown: true, registrationId: args.registrationId,
            createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true })
        }).catch(err => console.error('[whatsapp] unknown-outcome write failed', err))
      } else {
        recordStatus(args.registrationId, 'failed', { reason })
        logComm(args, email, phone, 'failed', { error: reason, providerResponse, deliveryUnknown })
      }
      return
    }

    // 6. Accepted → ONE idempotent acceptance record: charge + usage + log + status (retried).
    // From here on the message IS sent: a persistence problem must never relabel it failed or
    // hand back the unit it consumed (the catch below would do both). If every retry fails, the
    // status webhook replays the same record from the callback data.
    releaseOnError = async () => undefined
    if (!result.messageId) {
      console.error(`[whatsapp] accepted without a wamid — cannot record acceptance for ${args.registrationId}`)
    } else {
      try {
        await acceptConfirmation({
          registrationId: args.registrationId, organizerUid: args.organizerUid, eventSlug: args.eventSlug, eventName: args.eventName,
          attendeeName: args.attendeeName, email, phone, wamid: result.messageId, draftId: allowanceDraftId, writeLog: true, source: 'send',
          unitKey,
        })
      } catch (err) {
        console.error(`[whatsapp] acceptance not persisted for ${args.registrationId} — the status webhook will recover it:`, err)
      }
    }
    if (fromAllowance) console.info(`[whatsapp] registration confirmation billed to prepaid allowance · registrationId=${args.registrationId}`)
  } catch (err) {
    // Never let a WhatsApp problem surface to the caller — registration is done.
    console.error(`[whatsapp] confirmation error for ${args.registrationId}:`, err)
    await releaseOnError()
    recordStatus(args.registrationId, 'failed', {
      reason: err instanceof Error ? err.message : 'Unknown WhatsApp error',
    })
  }
}
