// RD-PAY-P0-4 — THE one settlement for a captured Razorpay payment. Server-only.
//
// ═══ WHY THIS MODULE EXISTS ═══════════════════════════════════════════════════
// A payment is captured the instant Razorpay's checkout handler fires. Everything after
// that — the verify-payment request, its response, the browser staying alive — is best
// effort. Three different things can end up finishing the job:
//
//   'verify'  — the attendee's browser, POST /api/registrations/verify-payment
//   'webhook' — payment.captured, when the browser never made it
//   'sweep'   — the reconciliation cron, when the webhook never made it either
//
// P0-3 unified the last two. They still differed from the FIRST in ways that changed the
// resulting registration, so the same paid attendee ended up with a different record
// depending on which path happened to win:
//
//   · coupon fields (couponCode / discountAmount / originalAmount) were dropped
//   · coupon `currentUses` was never consumed, so a capped coupon could over-redeem
//   · the coupon exhaustion cap was not re-checked
//   · the invite code was not re-validated against live accessControl
//   · the revenue counter used the GROSS charge instead of `financials.ticketBasePaise`
//   · the counter doc was read unconditionally, re-introducing the contention P1-4 removed
//   · the organizer inbox was not notified
//   · post-commit ran email BEFORE the wallet credit, the ordering P1-6 deliberately flipped
//
// All three callers now run THIS function. There is exactly one place that decides what a
// paid registration looks like.
//
// ═══ WHAT IT GUARANTEES ═══════════════════════════════════════════════════════
// · Exactly one registration per payment intent. The intent is READ INSIDE the transaction,
//   so concurrent callers serialize on it and every loser observes `paid` and no-ops. Every
//   downstream effect — coupon consumption, capacity, ticket, email, wallet credit — is
//   gated behind that same read, so each happens exactly once.
// · Refusals follow the EXISTING policy: mark the intent failed, refund in full, and write a
//   failedRefunds doc if the refund API itself fails. No new business rule is introduced.

import crypto           from 'crypto'
import { FieldValue }   from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import { generateTicketCode, TicketCodeCollisionError } from '@/lib/registrations/ticketCode'
import { buildCounterIncrement }     from '@/lib/firebase/firestore/registrationCounters'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { checkRegistrationGate }     from '@/lib/registrations/gate'
import {
  CapacityExceededError,
  DuplicateRegistrationError,
  CouponExhaustedError,
} from '@/lib/firebase/firestore/registrations'
import type { CouponDocument }       from '@/lib/coupons/types'
import { validateInviteCode }        from '@/app/api/registrations/validate-invite-code/route'
import {
  markPaymentIntentFailed,
  updatePaymentIntentRefund,
  type PaymentIntentRecord,
} from '@/lib/firebase/firestore/paymentIntents'
import { sendConfirmationEmail }     from '@/lib/registrations/sendConfirmationEmail'
import { notifyPaymentReceived }     from '@/lib/notifications/inbox/notify'
import { buildRegistrationLedgerAndCredit } from '@/lib/payments/registrationLedger'
import { recordPlatformTransactionAndCredit } from '@/lib/firebase/firestore/platformTransactions'
import { recordRegistrationFinancialReconciliation } from '@/lib/payments/registrationReconciliation'
import { razorpay }                  from '@/lib/razorpay/client'
import { captureFinancialError }     from '@/lib/monitoring/sentry'

/** Which path is settling. Only affects the unexpected-error policy and the recovery marker. */
export type SettlementSource = 'verify' | 'webhook' | 'sweep'

/** Canonical refusal codes. Callers map these onto their own responses. */
export type SettlementRefusal =
  | 'DUPLICATE_EMAIL' | 'DUPLICATE_MOBILE'
  | 'EVENT_CAPACITY_FULL' | 'PASS_CAPACITY_FULL' | 'PASS_NOT_AVAILABLE'
  | 'COUPON_EXHAUSTED' | 'INVITE_CODE_INVALID'
  | 'ticket_code_exhausted' | 'transaction_error'
  | string   // gate reasons pass through verbatim (EVENT_CANCELLED, REGISTRATION_CLOSED, …)

export type SettlementOutcome =
  /** A registration was created by THIS call. */
  | { kind: 'settled';         registrationId: string }
  /** Someone else already settled it. */
  | { kind: 'already_settled'; registrationId: string }
  /** Refused on an existing business rule; the payment has been refunded in full. */
  | { kind: 'refunded';        reason: SettlementRefusal; gateBlocked?: boolean }
  /**
   * RD-PAY-DUP-HOLD — refused as a DUPLICATE. The registration is blocked exactly as before,
   * the intent is terminal, but the captured payment is deliberately NOT auto-refunded: it is
   * parked as a `duplicate_hold` review record for an admin to settle by hand.
   */
  | { kind: 'held';            reason: 'DUPLICATE_EMAIL' | 'DUPLICATE_MOBILE' }
  /** Nothing written, nothing refunded — safe to retry later. */
  | { kind: 'deferred';        reason: string }

/** P0-1: invite re-validation failed inside the transaction. */
class InviteCodeError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'InviteCodeError' }
}

// ─── Refund (existing policy, unchanged) ──────────────────────────────────────

async function refundInFull(
  orderId: string, paymentId: string, amount: number, reason: string,
  ctx: { eventSlug: string; attendeeEmail: string; registrationId?: string },
): Promise<void> {
  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount, speed: 'optimum', notes: { reason, orderId },
      receipt: `refund_${orderId}`.slice(0, 40),
    })
    await updatePaymentIntentRefund(orderId, refund.id, refund.status, amount)
  } catch (refundErr) {
    captureFinancialError(refundErr, { scope: 'settleCaptured.refund_api_failed', detail: 'writing failedRefunds record', orderId, paymentId, amount, reason })
    adminDb.collection('failedRefunds').add({
      orderId, paymentId, amountPaise: amount, reason,
      eventSlug: ctx.eventSlug, attendeeEmail: ctx.attendeeEmail,
      registrationId: ctx.registrationId ?? null,
      status: 'open', createdAt: FieldValue.serverTimestamp(),
    }).catch(e => captureFinancialError(e, { scope: 'settleCaptured.failed_refund_persist_failed', detail: 'CRITICAL: could not write failedRefunds record', orderId, paymentId }))
  }
}

// ─── Duplicate hold (RD-PAY-DUP-HOLD) ─────────────────────────────────────────
//
// A duplicate refusal is the ONE refusal that must not auto-refund. Every other reason —
// capacity, pass unavailable, coupon exhausted, invite invalid, ticket-code exhaustion,
// gate blocked, transaction error — keeps refunding through refuse()/refundInFull(),
// which are deliberately left untouched.
//
// The captured payment is therefore parked, never silently orphaned:
//   • `status: 'review'`  — the admin retry endpoint refuses anything that is not 'open',
//                           so a hold can NEVER enter the refund path even by mistake.
//   • `kind: 'duplicate_hold'` — distinguishes it from a genuine failed refund. Records
//                           written before this field existed have no `kind` and are read
//                           as 'failed_refund', so nothing is migrated.
//
// IDEMPOTENT by deterministic id: one hold per ORDER, so a webhook replay or a sweep
// re-run can never open a second review record for the same payment.
async function recordDuplicateHold(
  orderId: string, paymentId: string, amount: number, reason: string,
  ctx: { eventSlug: string; attendeeEmail: string },
): Promise<void> {
  const ref = adminDb.collection('failedRefunds').doc(`duplicate_hold_${orderId}`)
  try {
    // `create` throws ALREADY_EXISTS rather than overwriting — that IS the idempotency,
    // and it also preserves the original createdAt on a replay.
    await ref.create({
      orderId, paymentId, amountPaise: amount, reason,
      eventSlug: ctx.eventSlug, attendeeEmail: ctx.attendeeEmail,
      registrationId: null,
      kind:      'duplicate_hold',
      status:    'review',
      createdAt: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    // ALREADY_EXISTS is the expected replay path and is not an error worth reporting.
    const code = (err as { code?: number | string })?.code
    if (code === 6 || code === 'already-exists') return
    captureFinancialError(err, {
      scope: 'settleCaptured.duplicate_hold_persist_failed',
      detail: 'CRITICAL: captured payment was not refunded and the review record could not be written',
      orderId, paymentId, amount, reason,
    })
  }
}

// ─── Settlement ───────────────────────────────────────────────────────────────

/**
 * Settle a captured payment into a registration.
 *
 * The caller MUST have already established that this payment belongs to this intent:
 * verify-payment by HMAC signature, the webhook by payload amount + currency, the sweep by
 * `orders.fetchPayments`. Everything else is read from the intent, which is the server-side
 * snapshot written at order creation — never from a client.
 */
export async function settleCapturedRegistration(args: {
  orderId:   string
  paymentId: string
  intent:    PaymentIntentRecord
  source:    SettlementSource
  /**
   * The uid of the Firebase session presenting the payment, when there is one. Used only by
   * 'verify' — an attendee who signed in AFTER creating the order still gets the
   * registration linked to their account. Recovery paths have no session and pass nothing.
   */
  uidOverride?: string
  /**
   * EXPLICIT ORPHANED-CAPTURE RECOVERY (RD-RECOVER-01). Present ONLY when the caller has
   * already proven at Razorpay that `paymentId` is a captured payment on `orderId`.
   *
   * It lifts exactly two things, and nothing else:
   *   1. the terminal-state guard — the whole point, since the intent was wrongly marked
   *      `registration_failed` by a payment.failed that a later capture superseded;
   *   2. the REFUND-on-gate-block, but only for timing reasons (sales window / registration
   *      window). This is not a new purchase: refunding a legitimate captured payment
   *      because the sales date has since elapsed would be the wrong outcome.
   *
   * Every other eligibility rule still applies and still stops the settlement — see the
   * `blocked` outcome. Absent ⇒ behaviour is byte-identical to before this existed.
   */
  recovery?: { verifiedCapturedPaymentId: string }
}): Promise<SettlementOutcome> {
  const { orderId, paymentId, intent, source, uidOverride } = args

  // Fast idempotency — avoids a transaction for the overwhelmingly common replay.
  if (intent.status === 'paid' && intent.registrationId) {
    return { kind: 'already_settled', registrationId: intent.registrationId }
  }
  // RECOVERY BYPASS #1 — the terminal-state guard. `registration_failed` is exactly the state
  // an orphaned capture is stuck in (a payment.failed marked it terminal, a later capture on
  // the same order was then skipped), so a recovery that has PROVEN the capture at Razorpay
  // must be allowed past. Every non-recovery caller still stops here, unchanged.
  const isRecovery = args.recovery?.verifiedCapturedPaymentId === paymentId
  if (!isRecovery && (intent.status === 'registration_failed' || intent.status === 'failed')) {
    return { kind: 'deferred', reason: 'intent_terminal' }
  }

  // F5: a cancelled / closed / full event must not receive this registration.
  const gate = await checkRegistrationGate(intent.eventSlug, intent.passId)
  if (!gate.allowed) {
    // RECOVERY BYPASS #2 — and ONLY for timing. A recovery is not a new purchase: the money
    // was taken while the window was open, so refunding it now because the sales/registration
    // date has since elapsed would punish the attendee for our own missed settlement.
    //
    // Deliberately narrow. Any OTHER refusal — cancelled, postponed, taken down, capacity or
    // pass full, invite-code — still stops the settlement. It is reported rather than
    // refunded, because auto-refunding an already-captured legitimate payment for a
    // substantive reason is an operator decision, not this function's to make.
    const TIMING_ONLY = new Set([
      'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'PASS_SALES_NOT_OPEN', 'PASS_SALES_ENDED',
    ])
    if (!(isRecovery && gate.reason && TIMING_ONLY.has(gate.reason))) {
      if (isRecovery) {
        captureFinancialError('recovery_gate_blocked', { scope: `settleCaptured.${source}.recovery_blocked`, orderId, paymentId, reason: gate.reason })
        return { kind: 'deferred', reason: `recovery_blocked:${gate.reason ?? 'gate_blocked'}` }
      }
      captureFinancialError('gate_blocked_after_capture', { scope: `settleCaptured.${source}.gate_blocked`, orderId, paymentId, reason: gate.reason })
      await markPaymentIntentFailed(orderId, gate.reason)
      await refundInFull(orderId, paymentId, intent.amount, `gate_blocked:${gate.reason}`, {
        eventSlug: intent.eventSlug, attendeeEmail: intent.attendee.email,
      })
      return { kind: 'refunded', reason: gate.reason ?? 'gate_blocked', gateBlocked: true }
    }
  }

  const normEmail = intent.attendee.email
  const normPhone = intent.attendee.phone

  const intentRef  = adminDb.collection('paymentIntents').doc(orderId)
  const eventRef   = adminDb.collection('events').doc(intent.eventSlug)
  const counterRef = adminDb.collection('registrationCounters').doc(intent.eventSlug)
  const regRef     = adminDb.collection('registrations').doc(crypto.randomUUID())

  const emailClaimRef = adminDb.collection('registrationClaims').doc(`${intent.eventSlug}_email_${normEmail}`)
  const phoneClaimRef = normPhone
    ? adminDb.collection('registrationClaims').doc(`${intent.eventSlug}_phone_${normPhone}`)
    : null

  // Coupon doc — read INSIDE the transaction so the usage cap is enforced atomically and
  // concurrent paid redemptions serialize on it. Identified from the intent's server-side
  // snapshot; a client-supplied coupon is never consulted here.
  const couponRef = (intent.couponDocId && intent.couponCode)
    ? adminDb.collection('events').doc(intent.eventSlug).collection('coupons').doc(intent.couponDocId)
    : null

  const registrationId = regRef.id
  const refundCtx = { eventSlug: intent.eventSlug, attendeeEmail: intent.attendee.email, registrationId }

  // F1: retry loop — a ticket-code collision regenerates and retries.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketCode         = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    let alreadySettled = false
    let settledId      = ''
    let capturedRawDetails: Record<string, unknown> = {}

    try {
      await adminDb.runTransaction(async txn => {
        // Phase 1: the intent is the serialization point for EVERY settlement path, and
        // the gate for every side effect below — coupon consumption included.
        const intentSnap = await txn.get(intentRef)
        const intentData = intentSnap.data() as PaymentIntentRecord | undefined
        if (!intentData) throw new Error('intent_vanished')

        if (intentData.status === 'paid' && intentData.registrationId) {
          alreadySettled = true
          settledId      = intentData.registrationId
          return
        }

        // Phase 2: the base counter is deliberately NOT read here (GA-7C P1-4) — it is read
        // below only when a capacity limit actually gates this registration, so uncapped
        // settlements don't abort each other on a single hot document.
        const [eventSnap, emailClaimSnap, ticketClaimSnap] = await Promise.all([
          txn.get(eventRef), txn.get(emailClaimRef), txn.get(ticketCodeClaimRef),
        ])
        const phoneClaimSnap = phoneClaimRef ? await txn.get(phoneClaimRef) : null
        const couponSnap     = couponRef     ? await txn.get(couponRef)     : null

        const eventData = eventSnap.data() as Record<string, unknown> | undefined
        capturedRawDetails = (eventData?.eventDetails ?? {}) as Record<string, unknown>

        // P0-1: re-validate the invite code against LIVE accessControl. The code was stored
        // on the intent by create-order after its own validation, so this is a server-side
        // snapshot, never a client value. Returns valid for events that need no code.
        const inviteValidation = validateInviteCode(eventData?.accessControl, intentData.inviteCode ?? '')
        if (!inviteValidation.valid) throw new InviteCodeError('INVITE_CODE_INVALID')

        const regForm  = eventData?.registrationForm as Record<string, unknown> | undefined
        const regRules = regForm?.registrationRules as { limitPerEmail?: boolean; limitPerMobile?: boolean } | undefined

        if (ticketClaimSnap.exists) throw new TicketCodeCollisionError()

        if (regRules?.limitPerEmail && emailClaimSnap.exists) throw new DuplicateRegistrationError('DUPLICATE_EMAIL')
        if (regRules?.limitPerMobile && phoneClaimSnap?.exists) throw new DuplicateRegistrationError('DUPLICATE_MOBILE')

        // Capacity — live from the transaction-locked event doc, never intent.passCapacity
        // (captured at order creation and possibly stale).
        const rawPricing = eventData?.pricing as Record<string, unknown> | null | undefined
        const livePasses = Array.isArray(rawPricing?.passes) ? (rawPricing?.passes as Record<string, unknown>[]) : []
        const livePass   = livePasses.find(p => p.id === intent.passId)
        if (!livePass) throw new CapacityExceededError('PASS_NOT_AVAILABLE')
        const livePassCapacity = livePass.unlimited === true
          ? null
          : typeof livePass.quantity === 'number' ? livePass.quantity : null
        const eventCapacity = deriveStoredEventCapacity(eventData)

        let totalCount = 0, passCount = 0
        if (eventCapacity !== null || livePassCapacity !== null) {
          const counterSnap = await txn.get(counterRef)
          const counterData = counterSnap.exists
            ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
            : null
          totalCount = counterData?.totalCount ?? 0
          passCount  = (counterData?.passCounts ?? {})[intent.passId] ?? 0
        }
        if (eventCapacity !== null && totalCount >= eventCapacity) throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        if (livePassCapacity !== null && passCount >= livePassCapacity) throw new CapacityExceededError('PASS_CAPACITY_FULL')

        // Coupon usage cap — re-checked in-transaction (couponRef is in the read set). The
        // loser of a race for the last use is refused here and refunded, so `currentUses`
        // can never exceed `maxUses`.
        if (couponRef && couponSnap?.exists) {
          const couponData = couponSnap.data() as CouponDocument
          if (typeof couponData.maxUses === 'number' && couponData.currentUses >= couponData.maxUses) {
            throw new CouponExhaustedError()
          }
        }

        txn.set(regRef, {
          id:              registrationId,
          eventSlug:       intent.eventSlug,
          passId:          intent.passId,
          passName:        intent.passName,
          eventName:       intent.eventName,
          organizerUid:    intent.organizerUid,
          attendee:        intent.attendee,
          status:          'confirmed',
          paymentStatus:   'paid',
          amount:          intent.amount,          // paise — from the intent, never a client
          razorpayOrderId: orderId,
          paymentId,
          ticketCode,
          // Consent audit trail — from the intent snapshot, never a client on this path.
          ...(intent.termsAccepted === true ? {
            termsAccepted:   true,
            termsAcceptedAt: FieldValue.serverTimestamp(),
            ...(intent.termsVersion ? { termsVersion: intent.termsVersion } : {}),
          } : {}),
          registeredAt:    FieldValue.serverTimestamp(),
          updatedAt:       FieldValue.serverTimestamp(),
          ...(uidOverride ?? intent.uid ? { uid: uidOverride ?? intent.uid } : {}),
          // Coupon fields — from the intent's server-side snapshot, on EVERY path.
          ...(intent.couponCode ? {
            couponCode:     intent.couponCode,
            ...(intent.discountAmount !== undefined ? { discountAmount: intent.discountAmount } : {}),
            ...(intent.originalAmount !== undefined ? { originalAmount: intent.originalAmount } : {}),
          } : {}),
          // Recovery marker — additive, and only on the paths that are recoveries.
          ...(source === 'webhook' ? { recoveredByWebhook: true } : {}),
          ...(source === 'sweep'   ? { recoveredByWebhook: true, recoveredBySweep: true } : {}),
        })

        // Consume the coupon atomically with the registration. Reached only once per
        // intent, because the intent read above is the gate for this whole block.
        if (couponRef) {
          txn.update(couponRef, { currentUses: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
        }

        // RD-PAYMENT-05 B2: the counter tracks ORGANIZER revenue (the ticket base) — the
        // same canonical basis the ledger, wallet and finance use — NOT the attendee charge.
        // Under organizer_pays these are identical; under attendee_pays this strips the
        // attendee-borne fees so dashboard revenue matches settlement.
        txn.set(counterRef, buildCounterIncrement(intent.eventSlug, intent.passId, {
          amountPaise: intent.financials?.ticketBasePaise ?? intent.amount,
        }), { merge: true })

        txn.update(intentRef, {
          status: 'paid', registrationId, paymentId, updatedAt: FieldValue.serverTimestamp(),
        })
        txn.set(ticketCodeClaimRef, { registrationId, eventSlug: intent.eventSlug, createdAt: FieldValue.serverTimestamp() })

        if (regRules?.limitPerEmail) {
          txn.set(emailClaimRef, { registrationId, eventSlug: intent.eventSlug, email: normEmail, createdAt: FieldValue.serverTimestamp() })
        }
        if (regRules?.limitPerMobile && phoneClaimRef && normPhone) {
          txn.set(phoneClaimRef, { registrationId, eventSlug: intent.eventSlug, phone: normPhone, createdAt: FieldValue.serverTimestamp() })
        }
      })

      if (alreadySettled) return { kind: 'already_settled', registrationId: settledId }

      // ── Post-commit. The registration is durable; nothing below may refund it. ──
      //
      // P1-6 ORDER: financial operations FIRST. Email delivery is a 1–3s provider
      // round-trip, and a crash inside it used to leave the wallet un-credited with no
      // recovery path; the ledger write is milliseconds.
      if (intent.amount > 0) {
        const { ledger, credit } = await buildRegistrationLedgerAndCredit({
          registrationId,
          organizerUid:     intent.organizerUid,
          eventSlug:        intent.eventSlug,
          attendeeName:     intent.attendee.name,
          attendeeEmail:    intent.attendee.email,
          grossAmountPaise: intent.amount,
          paymentId, orderId,
          financials:       intent.financials,
        })
        // Idempotent on ptx_<registrationId>, so whichever path settles credits once.
        try {
          await recordPlatformTransactionAndCredit(ledger, credit)
        } catch (walletErr) {
          await recordRegistrationFinancialReconciliation({
            registrationId, orderId, paymentId, ledger, credit,
            error: walletErr instanceof Error ? walletErr.message : 'financial_side_effect_failed',
          })
        }
      }

      try {
        await sendConfirmationEmail({
          registrationId, ticketCode,
          attendeeName:  intent.attendee.name,
          attendeeEmail: intent.attendee.email,
          eventName:     intent.eventName,
          passName:      intent.passName,
          rawDetails:    capturedRawDetails,
          organizerUid:  intent.organizerUid,
          eventSlug:     intent.eventSlug,
          amountPaid:    intent.amount,
        })
      } catch (emailErr) {
        captureFinancialError(emailErr, { scope: `settleCaptured.${source}.email_failed`, detail: 'non-fatal', registrationId })
      }

      // Organizer Notification Center (best-effort; deduped per registration).
      void notifyPaymentReceived({
        workspaceUid:   intent.organizerUid,
        registrationId,
        eventName:      intent.eventName,
        amountPaise:    intent.amount,
        attendeeName:   intent.attendee.name,
      })

      return { kind: 'settled', registrationId }

    } catch (err) {
      if (err instanceof TicketCodeCollisionError) {
        if (attempt < 4) continue
        return refuse('ticket_code_exhausted')
      }
      // RD-PAY-DUP-HOLD — the ONLY reason that bypasses refundInFull(). The registration is
      // still refused; only the automatic refund is withheld, and the payment is parked for
      // review instead. Every other branch below is unchanged.
      if (err instanceof DuplicateRegistrationError)  return holdForReview(err.reason)
      if (err instanceof CapacityExceededError)       return refuse(err.reason)
      if (err instanceof CouponExhaustedError)        return refuse('COUPON_EXHAUSTED')
      if (err instanceof InviteCodeError)             return refuse(err.reason)

      // Unexpected. 'verify' and 'webhook' have always refunded here and that is preserved:
      // both are one-shot (Razorpay retries a webhook indefinitely against a broken state).
      // The SWEEP defers instead — it runs on a schedule and will simply look again, so a
      // transient Firestore blip must never turn a good payment into a refund.
      if (source === 'sweep') {
        captureFinancialError(err, { scope: 'settleCaptured.sweep.deferred', detail: 'left recoverable for the next run', orderId, paymentId })
        return { kind: 'deferred', reason: 'transaction_error' }
      }
      captureFinancialError(err, { scope: `settleCaptured.${source}.transaction_failed`, orderId, paymentId, eventSlug: intent.eventSlug })
      return refuse('transaction_error')
    }

    /**
     * RD-PAY-DUP-HOLD — a duplicate refusal: terminal intent, NO automatic refund.
     *
     * Deliberately a sibling of refuse() rather than a flag inside it: refuse() is shared by
     * seven other refusal reasons whose refunds must keep working exactly as they do today,
     * and a conditional inside it would put every one of those refunds one edit away from
     * being switched off.
     */
    async function holdForReview(reason: 'DUPLICATE_EMAIL' | 'DUPLICATE_MOBILE'): Promise<SettlementOutcome> {
      captureFinancialError(`settlement_duplicate_hold:${reason}`, {
        scope: `settleCaptured.${source}.duplicate_hold`,
        detail: 'registration refused as a duplicate; payment captured and held for manual review (NOT refunded)',
        orderId, paymentId, reason, amount: intent.amount,
      })
      // Terminal FIRST, so the entry guard short-circuits any replay before it can reach
      // this branch again — the same ordering refuse() uses.
      await markPaymentIntentFailed(orderId, reason)
      await recordDuplicateHold(orderId, paymentId, intent.amount, reason, {
        eventSlug: intent.eventSlug, attendeeEmail: intent.attendee.email,
      })
      return { kind: 'held', reason }
    }

    // Mark failed + refund in full, then report the canonical reason.
    async function refuse(reason: SettlementRefusal): Promise<SettlementOutcome> {
      captureFinancialError(`settlement_refused:${reason}`, { scope: `settleCaptured.${source}.refused`, orderId, paymentId, reason, amount: intent.amount })
      await markPaymentIntentFailed(orderId, reason)
      await refundInFull(orderId, paymentId, intent.amount, reason, refundCtx)
      return { kind: 'refunded', reason }
    }
  }

  // Unreachable — every iteration returns or continues.
  return { kind: 'deferred', reason: 'retries_exhausted' }
}
