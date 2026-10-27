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
import { stageDailyStatsIncrement }  from '@/lib/dashboard/dailyStatsAdmin'
import { settlementRevenueBasisPaise } from '@/lib/registrations/revenueBasis'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { EVENT_LICENSES_COLLECTION } from '@/lib/licensing/schema'
import { licenceRegistrationBlock, LICENCE_INACTIVE } from '@/lib/licensing/licenceRegistrationBlock'
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
  type PaymentIntentRecord,
} from '@/lib/firebase/firestore/paymentIntents'
import { sendConfirmationEmail }     from '@/lib/registrations/sendConfirmationEmail'
import { notifyPaymentReceived }     from '@/lib/notifications/inbox/notify'
import { buildRegistrationLedgerAndCredit } from '@/lib/payments/registrationLedger'
import { recordPlatformTransactionAndCredit } from '@/lib/firebase/firestore/platformTransactions'
import { recordRegistrationFinancialReconciliation } from '@/lib/payments/registrationReconciliation'
import { buildRegistrationPaymentFields } from '@/lib/registrations/paymentIdentifiers'
// The Razorpay client is deliberately NOT imported. This module settles captured payments
// and can no longer refund them, so it has no business holding a gateway handle at all —
// the absent import is part of the guarantee, not an oversight.
import { captureFinancialError }     from '@/lib/monitoring/sentry'
import { flagSuspiciousPayment }     from '@/lib/payments/flagSuspicious'
import { whatsappConsentFields }     from '@/lib/whatsapp/broadcastConsent'
import { resolveEventWaiver, waiverRegistrationFields } from '@/lib/registrations/waiver'

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
  /**
   * RD-PAYMENT-REFUND-AUTHORITY-02 — refused, and the captured payment is PARKED.
   *
   * This used to be two outcomes: `held` for duplicates and `refunded` for everything else.
   * `refunded` is gone, and so is the refund call that produced it. A captured payment is
   * never handed back by this module for any reason; a refusal writes a durable review
   * record and a human with refund authority decides what happens to the money.
   *
   * `gateBlocked` is carried so callers can tell "the event closed underneath this payment"
   * apart from a capacity or coupon refusal when they phrase the attendee-facing message.
   */
  | { kind: 'held';            reason: SettlementRefusal; gateBlocked?: boolean }
  /**
   * Nothing written, nothing refunded — safe to retry later, and something WILL retry.
   * This is the transient-failure outcome: the recovery sweep runs every 10 minutes and
   * settles it on a later pass.
   */
  | { kind: 'deferred';        reason: string }

/** P0-1: invite re-validation failed inside the transaction. */
/** RD-FIN-02 · R1 — the order carries a captured-payment hold: a Super Admin decides it, not settlement. */
class HeldForReviewError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'HeldForReviewError' }
}

class InviteCodeError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'InviteCodeError' }
}

// ═══ RD-PAYMENT-REFUND-AUTHORITY-02 · THIS MODULE CANNOT REFUND ══════════════
//
// `refundInFull` used to live here and was reached by seven refusal branches. It is gone,
// not disabled — there is no longer any code path from settlement to the gateway's refund
// API, and no flag that could switch one back on by accident.
//
// Why removal rather than a guard: a captured payment is the attendee's money and the
// organizer's sale. Handing it back is a financial decision with a counterparty, and the
// three callers of this module are a browser callback, a webhook retry and a cron sweep —
// none of which is a person who can be accountable for that decision. The worst branch was
// `transaction_error`: a transient Firestore blip destroyed a good sale automatically.
//
// Refunds now have exactly one home: the Super-Admin-only routes. See lib/admin/auth
// (`resolveSuperAdminUid`) and tests/unit/refundCallSiteBoundary.test.ts, which fails the
// build if a new provider-refund call site appears outside that boundary.

/**
 * The two hold kinds. Both mean "captured payment, no registration, needs a human".
 *
 * `duplicate_hold` is kept as its own kind and its own document id so records written by
 * RD-PAY-DUP-HOLD keep their identity and nothing has to be migrated. `settlement_hold`
 * covers every other refusal now that none of them refunds.
 */
export type CapturedHoldKind = 'duplicate_hold' | 'settlement_hold' | 'duplicate_payment_hold'

// ─── Captured-payment hold (RD-PAY-DUP-HOLD, generalised by RD-PAYMENT-REFUND-AUTHORITY-02)
//
// Originally a duplicate refusal was the ONE refusal that did not auto-refund. Every other
// reason went through refuse() → refundInFull(). That function no longer exists, so this is
// now the single terminus for every refusal: the payment is parked, never handed back and
// never silently orphaned.
//
//   • `status: 'review'`  — the admin retry endpoint refuses anything that is not 'open',
//                           so a hold can NEVER enter the refund path even by mistake.
//   • `kind`              — distinguishes a hold from a genuine failed refund. Records
//                           written before this field existed have no `kind` and are read
//                           as 'failed_refund', so nothing is migrated.
//
// IDEMPOTENT by deterministic id: one hold per ORDER **per kind**, so a webhook replay or a
// sweep re-run can never open a second review record for the same payment.
//
// The record deliberately stores identifiers rather than a copy of the attendee: the
// authoritative payload already lives in paymentIntents/{orderId}, and duplicating PII into
// a second collection would be a second thing to leak and a second thing to keep in step.
async function recordCapturedHold(
  orderId: string, paymentId: string, amount: number, reason: string,
  kind: CapturedHoldKind,
  ctx: { eventSlug: string; attendeeEmail: string },
): Promise<void> {
  const ref = adminDb.collection('failedRefunds').doc(`${kind}_${orderId}`)
  try {
    // `create` throws ALREADY_EXISTS rather than overwriting — that IS the idempotency,
    // and it also preserves the original createdAt on a replay.
    await ref.create({
      orderId, paymentId, amountPaise: amount, reason,
      eventSlug: ctx.eventSlug, attendeeEmail: ctx.attendeeEmail,
      registrationId: null,
      kind,
      status:    'review',
      createdAt: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    // ALREADY_EXISTS is the expected replay path and is not an error worth reporting.
    const code = (err as { code?: number | string })?.code
    if (code === 6 || code === 'already-exists') return
    captureFinancialError(err, {
      scope: `settleCaptured.${kind}_persist_failed`,
      detail: 'CRITICAL: captured payment was not refunded and the review record could not be written',
      orderId, paymentId, amount, reason,
    })
  }
}

/**
 * RD-FIN-02 · B6 — a SECOND captured payment on a registration order that is already PAID.
 *
 * Mirrors recordDuplicateLicensePayment / recordDuplicateTopupPayment: keyed by the PAYMENT (a third
 * payment is its own record; a replay changes nothing), status 'review' (the registration hold
 * workflow — a Super Admin decides), and NOTHING else: no registration, no counter / revenue / ledger
 * write, never refunded here. `registrationId: null` is LOAD-BEARING — the retry route marks
 * `registrationId` refunded, and this money never produced a registration; the settled one is carried
 * separately as `settledRegistrationId`. Returns whether the record is durable. Never throws.
 */
export async function recordDuplicateRegistrationPayment(input: {
  orderId: string; paymentId: string; settledPaymentId: string; settledRegistrationId: string
  amountPaise: number; eventSlug: string; attendeeEmail: string; organizerUid: string
  detectedBy: SettlementSource
}): Promise<boolean> {
  const ref = adminDb.collection('failedRefunds').doc(`duplicate_payment_hold_${input.paymentId}`)
  let created = false
  try {
    created = await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (snap.exists) {
        tx.update(ref, { detectedBy: FieldValue.arrayUnion(input.detectedBy), updatedAt: FieldValue.serverTimestamp() })
        return false
      }
      tx.create(ref, {
        orderId: input.orderId, paymentId: input.paymentId, amountPaise: input.amountPaise,
        reason: 'duplicate_payment', eventSlug: input.eventSlug, attendeeEmail: input.attendeeEmail,
        registrationId: null,
        settledRegistrationId: input.settledRegistrationId, settledPaymentId: input.settledPaymentId,
        organizerUid: input.organizerUid,
        kind: 'duplicate_payment_hold', status: 'review', detectedBy: [input.detectedBy],
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
      return true
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'settleCaptured.duplicate_payment_persist_failed',
      detail: 'CRITICAL: second captured payment on a paid order was not recorded', orderId: input.orderId, paymentId: input.paymentId })
    return false
  }
  if (created) {
    await flagSuspiciousPayment({ source: 'registration', reason: 'duplicate_payment', paymentId: input.paymentId,
      orderId: input.orderId, expectedAmountPaise: input.amountPaise, actualAmountPaise: input.amountPaise,
      expectedCurrency: 'INR', actualCurrency: 'INR' })
  }
  return true
}

// RD-FIN-01 · markPaymentIntentFailed refused because the intent is already PAID — another
// path (verify / webhook / sweep) settled it. Report that settlement instead of a hold.
async function settledElsewhere(orderId: string): Promise<SettlementOutcome> {
  const snap = await adminDb.collection('paymentIntents').doc(orderId).get()
  const registrationId = snap.get('registrationId') as string | undefined
  return registrationId
    ? { kind: 'already_settled', registrationId }
    : { kind: 'deferred', reason: 'intent_paid_without_registration' }
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
    // RD-FIN-02 · B6 — the order is settled by ANOTHER payment: record this one for review.
    if (intent.paymentId && intent.paymentId !== paymentId) {
      await recordDuplicateRegistrationPayment({ orderId, paymentId, settledPaymentId: intent.paymentId,
        settledRegistrationId: intent.registrationId, amountPaise: intent.amount, eventSlug: intent.eventSlug,
        attendeeEmail: intent.attendee.email, organizerUid: intent.organizerUid, detectedBy: source })
    }
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
    // pass full, invite-code — still stops the settlement. It is HELD rather than refunded:
    // auto-refunding an already-captured legitimate payment for a substantive reason is an
    // operator decision, not this function's to make. (RD-PAYMENT-REFUND-AUTHORITY-02 made
    // that sentence literally true — it used to say so and then refund anyway.)
    const TIMING_ONLY = new Set([
      'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'PASS_SALES_NOT_OPEN', 'PASS_SALES_ENDED',
    ])
    if (!(isRecovery && gate.reason && TIMING_ONLY.has(gate.reason))) {
      if (isRecovery) {
        captureFinancialError('recovery_gate_blocked', { scope: `settleCaptured.${source}.recovery_blocked`, orderId, paymentId, reason: gate.reason })
        return { kind: 'deferred', reason: `recovery_blocked:${gate.reason ?? 'gate_blocked'}` }
      }
      captureFinancialError('gate_blocked_after_capture', { scope: `settleCaptured.${source}.gate_blocked`, orderId, paymentId, reason: gate.reason })
      const gateReason = gate.reason ?? 'gate_blocked'
      // RD-FIN-01 · the gate read above is OUTSIDE the transaction: a concurrent path may have
      // settled this intent meanwhile (e.g. it took the last seat — which is WHY the gate now
      // says full). A paid intent is never marked failed and never gets a hold.
      if (!(await markPaymentIntentFailed(orderId, gateReason))) return settledElsewhere(orderId)
      await recordCapturedHold(orderId, paymentId, intent.amount, `gate_blocked:${gateReason}`,
        'settlement_hold', { eventSlug: intent.eventSlug, attendeeEmail: intent.attendee.email })
      return { kind: 'held', reason: gateReason, gateBlocked: true }
    }
  }

  const normEmail = intent.attendee.email
  const normPhone = intent.attendee.phone

  const intentRef  = adminDb.collection('paymentIntents').doc(orderId)
  const eventRef   = adminDb.collection('events').doc(intent.eventSlug)
  const licenceRef = adminDb.collection(EVENT_LICENSES_COLLECTION).doc(intent.eventSlug)
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

  // F1: retry loop — a ticket-code collision regenerates and retries.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketCode         = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    let alreadySettled = false
    let settledId      = ''
    let settledPaymentId: string | undefined
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
          settledPaymentId = intentData.paymentId
          return
        }

        // RD-FIN-02 · R1 — a terminal intent may be one THIS function parked for review. Recovery
        // exists for the payment.failed → captured trap, NOT to overrule a hold: a payment must never
        // be both a settled registration AND an open "refund or not?" decision. Never settle an order
        // that has a hold, whatever its state (review = undecided; open / retrying / retried = refund
        // approved or issued; resolved = decided). Read in THIS transaction (reads before writes), and
        // only for terminal intents, so the common path costs nothing.
        if (intentData.status === 'registration_failed' || intentData.status === 'failed') {
          const holdSnaps = await txn.getAll(
            adminDb.collection('failedRefunds').doc(`settlement_hold_${orderId}`),
            adminDb.collection('failedRefunds').doc(`duplicate_hold_${orderId}`),
          )
          const hold = holdSnaps.find(s => s.exists)
          if (hold) throw new HeldForReviewError(hold.get('status') === 'review' ? 'HELD_FOR_REVIEW' : 'HOLD_DECISION_TAKEN')
        }

        // Phase 2: the base counter is deliberately NOT read here (GA-7C P1-4) — it is read
        // below only when a capacity limit actually gates this registration, so uncapped
        // settlements don't abort each other on a single hot document.
        const [eventSnap, licenceSnap, emailClaimSnap, ticketClaimSnap] = await Promise.all([
          txn.get(eventRef), txn.get(licenceRef), txn.get(emailClaimRef), txn.get(ticketCodeClaimRef),
        ])
        // RD-SA-COMMERCE-P1 — a suspended / cancelled / refunded licence takes no new seat. Read in
        // THIS transaction; the refusal parks the captured payment for Super Admin review (never an
        // automatic refund), exactly like a full event.
        if (licenceRegistrationBlock(licenceSnap.data())) throw new CapacityExceededError(LICENCE_INACTIVE)
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
          // RD-FIN-02 B5 · attendee-borne fees inside `amount`, ONLY when present, so cancel /
          // restore / reconciliation reverse exactly the ticket base the counter added below.
          ...(intent.amount - settlementRevenueBasisPaise(intent) > 0
            ? { attendeeFeePaise: intent.amount - settlementRevenueBasisPaise(intent) } : {}),
          // Provider-neutral identifiers. `razorpayOrderId` is still mirrored for Razorpay
          // (every historical reader, export and support lookup depends on it) and is
          // deliberately ABSENT for any other provider, so no gateway's order id is ever
          // stored in a field named for a different one.
          ...buildRegistrationPaymentFields(intent.provider, orderId),
          paymentId,
          ticketCode,
          // RD-CHECKIN-FILTER-01 — written explicitly, as createRegistration does for free / walk-in
          // registrations. Without it a paid registration had NO `checkedIn` field, so the
          // Registrations "Not checked in" filter (an equality on `false`) never matched it.
          checkedIn:       false,
          // Consent audit trail — from the intent snapshot, never a client on this path.
          ...(intent.termsAccepted === true ? {
            termsAccepted:   true,
            termsAcceptedAt: FieldValue.serverTimestamp(),
            ...(intent.termsVersion ? { termsVersion: intent.termsVersion } : {}),
          } : {}),
          // RD-COMMS-WA-CONSENT — explicit WhatsApp broadcast opt-in, from the same snapshot.
          ...whatsappConsentFields(intent.whatsappBroadcastOptIn, intent.attendee?.phone),
          // RD-WAIVER-01 · the acceptance validated at create-order (server time + wording hash),
          // from the intent snapshot. Money is already captured here, so settlement RECORDS — it
          // never refuses over the waiver; enforcement happened before any order existed.
          ...waiverRegistrationFields(resolveEventWaiver(eventData), intent.waiverAcceptance ?? null),
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
        const counterRevenuePaise = settlementRevenueBasisPaise(intent)
        txn.set(counterRef, buildCounterIncrement(intent.eventSlug, intent.passId, {
          amountPaise: counterRevenuePaise,
        }), { merge: true })
        // RD-FIN-01 · the organizer daily rollup, in the SAME transaction as the counter —
        // exactly as createRegistration does for free registrations. Online paid registrations
        // were never written here, so the dashboard Today / month / trend / deltas and the
        // analytics day series omitted every one of them, while cancelRegistration still
        // reversed them on their original day (driving that day below its true value).
        stageDailyStatsIncrement(txn, intent.organizerUid, intent.eventSlug, Date.now(), {
          action: 'confirm', amountPaise: counterRevenuePaise,
        })

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

      if (alreadySettled) {
        // RD-FIN-02 · B6 — settled meanwhile by a DIFFERENT payment (a race): record this one.
        if (settledPaymentId && settledPaymentId !== paymentId) {
          await recordDuplicateRegistrationPayment({ orderId, paymentId, settledPaymentId,
            settledRegistrationId: settledId, amountPaise: intent.amount, eventSlug: intent.eventSlug,
            attendeeEmail: intent.attendee.email, organizerUid: intent.organizerUid, detectedBy: source })
        }
        return { kind: 'already_settled', registrationId: settledId }
      }

      // ── Post-commit. The registration is durable; nothing below may refund it. ──
      //
      // P1-6 ORDER: financial operations FIRST. Email delivery is a 1–3s provider
      // round-trip, and a crash inside it used to leave the wallet un-credited with no
      // recovery path; the ledger write is milliseconds.
      if (intent.amount > 0) {
        const { ledger, credit } = await buildRegistrationLedgerAndCredit({
          registrationId,
          // RD-PAYMENT-PROVIDER-CONTRACT-04 — carried from the intent, not chosen here.
          // Settlement stays provider-INDEPENDENT: it copies a discriminator it was given
          // and never asks who the provider is or behaves differently because of it.
          provider:         intent.provider,
          organizerUid:     intent.organizerUid,
          eventSlug:        intent.eventSlug,
          attendeeName:     intent.attendee.name,
          attendeeEmail:    intent.attendee.email,
          grossAmountPaise: intent.amount,
          paymentId, orderId,
          financials:       intent.financials,
          // RD-PHASE4-S2 — the fee inputs captured at checkout (never the live configuration).
          feeInputs:        intent.feeInputs,
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
          // RD-FEE-RESTORE-01 — the canonical record this capture was priced with. Present only
          // when the pricing engine wrote one; null/absent keeps the email exactly as it is today.
          financials:    intent.financials ?? null,
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
        return holdForReview('ticket_code_exhausted')
      }
      // ═══ RD-PAYMENT-REFUND-AUTHORITY-02 · EVERY refusal now parks the money ══
      // These are BUSINESS refusals: retrying will not change the answer, so they are
      // terminal and get a durable review record. What changed is only what happens to the
      // captured payment — it stays captured. Whether the attendee is refunded, given a
      // place anyway, or moved to another pass is a decision with a counterparty, and it is
      // made by a Super Admin looking at the hold, not by this function.
      // RD-FIN-02 · R1 — already held: report it, write NOTHING (never a second hold).
      if (err instanceof HeldForReviewError)          return { kind: 'held', reason: err.reason }
      if (err instanceof DuplicateRegistrationError)  return holdForReview(err.reason, 'duplicate_hold')
      if (err instanceof CapacityExceededError)       return holdForReview(err.reason)
      if (err instanceof CouponExhaustedError)        return holdForReview('COUPON_EXHAUSTED')
      if (err instanceof InviteCodeError)             return holdForReview(err.reason)

      // ═══ P0 · TRANSIENT FAILURE — DEFER, NEVER TERMINAL ═════════════════════
      // This branch used to refund for 'verify' and 'webhook', on the reasoning that both
      // are one-shot. That reasoning traded a recoverable problem for an unrecoverable one:
      // a Firestore blip lasting seconds destroyed a completed sale, and a refund cannot be
      // undone. The sweep's behaviour was already correct and is now used for all three
      // sources — nothing is written, nothing is marked terminal, and
      // recoverCapturedPaymentIntents settles it on a later pass (it runs every 10 minutes
      // and keeps a 24h window).
      //
      // Deliberately NOT a hold: a hold is for refusals a human must resolve. A transient
      // error resolves itself, and parking it would put a review record in front of someone
      // for something that fixes itself in ten minutes.
      captureFinancialError(err, {
        scope:  `settleCaptured.${source}.transaction_failed`,
        detail: 'left recoverable for the capture sweep — payment captured, NOT refunded',
        orderId, paymentId, eventSlug: intent.eventSlug,
      })
      return { kind: 'deferred', reason: 'transaction_error' }
    }

    /**
     * RD-PAY-DUP-HOLD — a duplicate refusal: terminal intent, NO automatic refund.
     *
     * Deliberately a sibling of refuse() rather than a flag inside it: refuse() is shared by
     * seven other refusal reasons whose refunds must keep working exactly as they do today,
     * and a conditional inside it would put every one of those refunds one edit away from
     * being switched off.
     */
    async function holdForReview(
      reason: SettlementRefusal,
      kind: CapturedHoldKind = 'settlement_hold',
      gateBlocked = false,
    ): Promise<SettlementOutcome> {
      captureFinancialError(`settlement_hold:${reason}`, {
        scope: `settleCaptured.${source}.${kind}`,
        detail: 'registration refused; payment captured and held for Super Admin review (NOT refunded)',
        orderId, paymentId, reason, amount: intent.amount,
      })
      // Terminal FIRST, so the entry guard short-circuits any replay before it can reach
      // this branch again and the hold write below stays the only side effect worth racing.
      // RD-FIN-01 · unless another path settled it meanwhile — then there is nothing to hold.
      if (!(await markPaymentIntentFailed(orderId, reason))) return settledElsewhere(orderId)
      await recordCapturedHold(orderId, paymentId, intent.amount, reason, kind, {
        eventSlug: intent.eventSlug, attendeeEmail: intent.attendee.email,
      })
      return gateBlocked ? { kind: 'held', reason, gateBlocked } : { kind: 'held', reason }
    }
  }

  // Unreachable — every iteration returns or continues.
  return { kind: 'deferred', reason: 'retries_exhausted' }
}
