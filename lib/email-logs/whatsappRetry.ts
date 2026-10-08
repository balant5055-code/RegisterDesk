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
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { WHATSAPP_CAPACITY_REQUIRED } from '@/lib/communications/capacity'
import { getMetaProvider, resolveWhatsAppTemplate } from '@/lib/whatsapp'
import { NotificationType } from '@/lib/notifications'
import { validatePhoneNumber } from '@/lib/communication/phone'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { draftIdForEventSlug } from '@/lib/licensing/serviceAllowanceLedger'
import { reserveWhatsAppFunding, releaseWhatsAppFunding, confirmationHoldLedgerId } from '@/lib/whatsapp/funding'
import { acceptConfirmation } from '@/lib/registrations/whatsappConfirmationAcceptance'
import { callbackDataFor } from '@/lib/whatsapp/acceptance'

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
        | 'registration_missing' | 'already_sent' | 'delivery_unknown' | 'no_phone'
        | 'insufficient_balance' | 'template_unresolved' | 'send_failed'
        | 'send_unknown'          // RD-COMMS-P2-A — Meta never answered THIS attempt: delivery unknown
        | 'allowance_exhausted'   // RD-EVENT-COMMERCE-02 — prepaid allowance used up (no legacy balance covers it)
        | 'allowance_required'    // RD-COMMS-P1 — no WhatsApp capacity (and no legacy balance covers it)
      /** Normalized, organizer-safe message. Never contains credentials. */
      error: string
      /** Meta Graph error code, when the failure came from the provider. */
      code?: number
      httpStatus?: number
      /** Compact diagnostics in the same shape the live path logs. */
      providerResponse?: string
    }

/**
 * RD-WA-RETRY-01 — the caller EXPLICITLY authorises resending a delivery whose outcome
 * Meta never confirmed.
 *
 * This is the only way past the unknown guard, and it exists because the old behaviour —
 * refuse forever — left the organizer with no recovery action at all. It is a strict
 * boolean and it is never inferred: the risk being accepted (the attendee may receive the
 * message twice) is a human judgement, so a human has to make it.
 */
export interface WhatsAppRetryOptions {
  confirmUnknownDelivery?: boolean
  /**
   * RD-CLOSE — a per-attempt nonce (the route's claim). A retry is a NEW message, so a prepaid
   * unit is reserved under its own key: reusing the registration's key would find the unit an
   * earlier accepted message consumed and send this one for free.
   */
  attemptNonce?: string
}

export interface WhatsAppRetryArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
}

// RD-CLOSE — an accepted retry is recorded by the SAME acceptance transaction as the live send
// (acceptConfirmation): charge + usage + registration status, idempotent per wamid. A retry that
// Meta accepts is a NEW message and is billed as one (a registration's first accepted message uses
// the legacy ledger id `whatsapp_<registrationId>`; later ones `…__<wamid>`).

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
  // RD-CLOSE — never DOWNGRADE a recorded send (the status webhook may have recorded it first).
  const ref = adminDb.collection('registrations').doc(registrationId)
  adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    if (!cur.exists) return
    if (status !== 'sent' && (cur.data() as { whatsappStatus?: unknown }).whatsappStatus === 'sent') return
    txn.update(ref, patch)
  }).catch(err => console.error(`[whatsapp-retry] status persist failed for ${registrationId}:`, err))
}

/**
 * Re-send one attendee registration confirmation over WhatsApp.
 *
 * Reads an existing registration; writes no registration and no payment. Unlike the live
 * path this RETURNS the outcome so the API can surface the exact Meta reason.
 */
export async function retryWhatsAppConfirmation(
  args: WhatsAppRetryArgs,
  opts?: WhatsAppRetryOptions,
): Promise<WhatsAppRetryResult> {
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

  const eventData = eventSnap.exists ? eventSnap.data() as { pricing?: { whatsappEnabled?: boolean }; draftId?: unknown } : undefined
  const pricing = eventData?.pricing
  // RD-INTEG — owner-checked ledger key, as every other WhatsApp path now resolves it.
  const allowanceDraftId = typeof eventData?.draftId === 'string' && eventData.draftId ? await draftIdForEventSlug(args.eventSlug) : null
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

  // ═══ UNKNOWN IS NOT A LICENCE TO RESEND ════════════════════════════════════
  // 'unknown' means the Meta request timed out, so RegisterDesk never learned whether the
  // message was accepted. A blind retry here is exactly the double-message risk: if Meta did
  // queue the original, the attendee gets the confirmation twice. There is also no wamid to
  // reconcile against, so no webhook can ever resolve it for us. Refuse, and tell the
  // organizer plainly — a human who has confirmed with the attendee can still act, but nothing
  // automatic will resend on their behalf.
  // ═══ INDETERMINATE DELIVERY ════════════════════════════════════════════════
  // Meta never confirmed the original attempt, so it may already have been accepted and
  // queued. Resending is therefore a real duplicate risk — but refusing forever left the
  // organizer stuck with a message they could neither confirm nor recover.
  //
  // So the block stands by DEFAULT and is lifted only by an explicit confirmation from the
  // caller. `=== true` is deliberate: a truthy string, 1, or an accidental object must not
  // open this path. Automatic and background callers pass nothing and stay blocked, which
  // is what keeps "unknown is never silently retried" true no matter who calls.
  if (reg.whatsappStatus === 'unknown' && opts?.confirmUnknownDelivery !== true) {
    return {
      ok: false,
      reason: 'delivery_unknown',
      error:  'Delivery status unknown — do not resend automatically. The message may already have reached the attendee.',
    }
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

  // A retry is a NEW message: its own unit key (per-attempt nonce from the route's claim).
  const unitKey = opts?.attemptNonce && /^[A-Za-z0-9_-]{1,64}$/.test(opts.attemptNonce)
    ? `wa_reg_${args.registrationId}__r_${opts.attemptNonce}`
    : `wa_reg_${args.registrationId}`
  // RD-COMMS-P2-A — funded BEFORE the send, atomically (lib/whatsapp/funding.ts): the event's capacity,
  // else the legacy balance while it covers the whole legacy price. Otherwise refused, nothing sent.
  const fundingKey = { organizerUid: args.organizerUid, draftId: allowanceDraftId, unitKey, holdLedgerId: confirmationHoldLedgerId(args.registrationId, unitKey) }
  const funding = await reserveWhatsAppFunding({
    ...fundingKey, legacyPricePaise: comm.whatsapp.pricePaise, source: 'registration_confirmation_retry',
    ledger: { referenceId: args.registrationId, description: `WhatsApp confirmation — ${args.eventName}`, eventSlug: args.eventSlug, metadata: { eventId: args.eventSlug, registrationId: args.registrationId } },
  })
  if (!funding.ok) {
    if (funding.reason === 'already_held') return { ok: false, reason: 'already_sent', error: 'This WhatsApp confirmation is already being sent.' }
    return { ok: false, reason: funding.reason, error: WHATSAPP_CAPACITY_REQUIRED }
  }
  // Only THIS attempt took the hold; an accepted hold is never released.
  const giveBack = () => releaseWhatsAppFunding(fundingKey).catch(err => console.error('[whatsapp-retry] funding release failed', err))

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
    await giveBack()
    recordStatus(args.registrationId, 'failed', { reason: resolved.error })
    return { ok: false, reason: 'template_unresolved', error: resolved.error }
  }

  // RD-CLOSE — callback data lets the status webhook recover this acceptance if persistence fails.
  // A throw is a transport failure like any other: the outcome is unknown, never "failed".
  const result = await provider.sendTemplate({ ...resolved.message, callbackData: callbackDataFor({ kind: 'registration', registrationId: args.registrationId, unitKey }) })
    .catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : 'transport failure', httpStatus: undefined, code: undefined, providerMessage: undefined, messageId: undefined }))
  if (!result.success) {
    // Same compact diagnostic string the live path stores, built only from httpStatus / code /
    // providerMessage — no credential ever reaches it.
    const providerResponse =
      `HTTP ${result.httpStatus ?? '-'} · code ${result.code ?? '-'} · ${result.providerMessage ?? result.error ?? 'unknown'}`
    // RD-COMMS-P2-A · A6 — no HTTP status ⇒ Meta never answered: delivery is UNKNOWN, exactly as the
    // live path records it. Not "failed" — that is what let the next retry go out with no
    // confirmation and double-message the attendee. The hold is KEPT for Meta's webhook to settle.
    if (result.httpStatus === undefined) {
      const error = `Delivery status unknown — no response from Meta (${result.error ?? 'transport failure'})`
      recordStatus(args.registrationId, 'unknown', { reason: error })
      return { ok: false, reason: 'send_unknown', error, providerResponse }
    }
    await giveBack()   // definitely refused ⇒ nothing consumed
    const error = result.error ?? 'WhatsApp send failed'
    recordStatus(args.registrationId, 'failed', { reason: error })
    return {
      ok: false, reason: 'send_failed', error,
      code: result.code, httpStatus: result.httpStatus, providerResponse,
    }
  }

  // Accepted → the one acceptance record (charge + usage + status), retried; the route updates the
  // log row it claimed. The message is sent: a persistence failure must not turn this into a
  // failure the organizer would retry (a duplicate) — the status webhook recovers it instead.
  let debited = 0
  if (result.messageId) {
    try {
      debited = (await acceptConfirmation({
        registrationId: args.registrationId, organizerUid: args.organizerUid, eventSlug: args.eventSlug, eventName: args.eventName,
        attendeeName: reg.attendee.name, email: reg.attendee.email ?? '', phone: normalizedPhone, wamid: result.messageId,
        draftId: allowanceDraftId, writeLog: false, source: 'retry', unitKey,
      })).chargedPaise
    } catch (err) {
      console.error(`[whatsapp-retry] acceptance not persisted for ${args.registrationId} — the status webhook will recover it:`, err)
    }
  }

  return { ok: true, messageId: result.messageId, costPaise: debited, recipient: normalizedPhone }
}
