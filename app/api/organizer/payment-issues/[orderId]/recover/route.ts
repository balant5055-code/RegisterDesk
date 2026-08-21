// POST /api/organizer/payment-issues/[orderId]/recover
//
// Creates the missing registration for ONE captured payment the organizer owns.
//
// ═══ WHAT THE BROWSER MAY SUPPLY: A CASE ID. NOTHING ELSE. ═══════════════════
// The only value that crosses the wire is `orderId`, and it is a LOOKUP, not an instruction.
// Every fact settlement depends on — the payment id, the amount, the currency, the event,
// the pass, the attendee's phone — is re-derived here from server data or from Razorpay.
// There is no request field that can alter any of them, which is what makes "an organizer
// cannot force a settlement" true by construction rather than by validation.
//
// A forged orderId belonging to another organizer fails the ownership check below, so the
// worst a caller can do with one is discover that it is not theirs.
//
// ═══ WHY IT RE-VERIFIES INSTEAD OF TRUSTING THE CASE ROW ═════════════════════
// The case row was written by a sweep that may have run minutes ago. Between then and now
// the payment could have been refunded, the registration created by the webhook, or the
// pass sold out. The row decides what to SHOW; Razorpay and the settlement decide what to DO.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { razorpay } from '@/lib/razorpay/client'
import { getPaymentIntent } from '@/lib/firebase/firestore/paymentIntents'
import { recoverOrphanedCapture } from '@/lib/payments/recoverOrphanedCapture'
import { upsertReconciliationCase, RECONCILIATION_CASES, type ReconciliationCase } from '@/lib/payments/reconciliationCases'
import { captureFinancialError } from '@/lib/monitoring/sentry'

export const dynamic = 'force-dynamic'

interface RouteContext { params: Promise<{ orderId: string }> }

export interface RecoverResponse {
  ok:              boolean
  registrationId?: string
  ticketCode?:     string
  /** Safe, human-readable. Never a stack trace, never a Razorpay payload. */
  message:         string
}

/**
 * Refusal reasons → sentences an organizer can act on.
 *
 * Deliberately a fixed table: the underlying reasons are internal symbols, and passing them
 * through verbatim would leak the shape of the payment system into a UI and change wording
 * whenever an internal name changed.
 */
const MESSAGES: Record<string, string> = {
  payment_not_on_order:            'Payment could not be verified.',
  payment_not_captured:            'Payment could not be verified.',
  currency_mismatch:               'Payment information does not match.',
  razorpay_amount_mismatch:        'Payment information does not match.',
  intent_amount_mismatch:          'Payment information does not match.',
  event_mismatch:                  'Payment information does not match.',
  pass_mismatch:                   'Payment information does not match.',
  phone_mismatch:                  'Payment information does not match.',
  razorpay_unreachable:            'The payment provider could not be reached. Please try again shortly.',
  intent_not_found:                'This case requires platform review.',
  intent_not_orphaned:             'Registration already exists.',
  intent_already_settled:          'Registration already exists.',
  registration_exists:             'Registration already exists.',
  registration_exists_for_payment: 'Registration already exists.',
  registration_exists_for_phone:   'Registration already exists.',
}

const say = (reason: string): string =>
  MESSAGES[reason] ?? (reason.startsWith('recovery_blocked') || reason.startsWith('deferred')
    ? 'Event or pass cannot accept this registration.'
    : 'This case requires platform review.')

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse<RecoverResponse>> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) {
    return NextResponse.json({ ok: false, message: authz.error }, { status: authz.status })
  }

  const { orderId } = await ctx.params

  // ── 1. The case must exist AND belong to this workspace ────────────────────
  // Checked before anything else is read, so a probe for someone else's order does no work
  // and reveals nothing beyond "not found".
  const caseSnap = await adminDb.collection(RECONCILIATION_CASES).doc(orderId).get()
  const kase = caseSnap.exists ? (caseSnap.data() as ReconciliationCase) : null
  if (!kase || kase.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ ok: false, message: 'Payment issue not found.' }, { status: 404 })
  }

  // ── 2. Already resolved ⇒ idempotent success ───────────────────────────────
  if (kase.status === 'resolved' && kase.registrationId) {
    return NextResponse.json({
      ok: true, registrationId: kase.registrationId,
      message: 'This registration has already been recovered.',
    })
  }

  // ── 3. Only an ACTIONABLE case may be recovered here ───────────────────────
  // `requires_review` exists precisely so an organizer cannot self-serve a case the platform
  // has not cleared — an unverified payment, or one a substantive gate refused.
  if (kase.status !== 'actionable' || kase.paymentState !== 'captured') {
    return NextResponse.json({ ok: false, message: 'This case requires platform review.' }, { status: 409 })
  }

  // ── 4. The intent is the source of truth for identity, not the case row ────
  const intent = await getPaymentIntent(orderId)
  if (!intent || intent.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ ok: false, message: 'Payment issue not found.' }, { status: 404 })
  }

  // ── 5. Re-ask Razorpay, and select deterministically ───────────────────────
  // Order-scoped, so membership is established by the lookup itself. The predicate is the
  // same one the sweep uses: a payment must match this intent's OWN amount and currency.
  // Never `items[0]`, never a paymentId from the request.
  let paymentId: string | undefined
  try {
    const res = await razorpay.orders.fetchPayments(orderId) as {
      items?: Array<{ id?: string; status?: string; amount?: number; currency?: string }>
    }
    paymentId = (res.items ?? []).find(p =>
      (p.status === 'captured' || p.status === 'authorized') &&
      p.currency === 'INR' && p.amount === intent.amount)?.id
  } catch (err) {
    // FAIL CLOSED. Unreachable is not "unpaid" and is certainly not permission to settle.
    captureFinancialError(err, { scope: 'organizerRecover.fetch_payments_failed', orderId })
    return NextResponse.json(
      { ok: false, message: MESSAGES.razorpay_unreachable }, { status: 503 },
    )
  }
  if (!paymentId) {
    return NextResponse.json({ ok: false, message: MESSAGES.payment_not_captured }, { status: 409 })
  }

  // ── 6. Hand to the EXISTING strict service, with every field server-derived ─
  // No settlement logic is duplicated here. `recoverOrphanedCapture` re-verifies all six
  // against Razorpay and the stored intent, then delegates to the one settlement
  // transaction — so idempotency, ticket claims, counters and the ledger are inherited.
  const outcome = await recoverOrphanedCapture({
    orderId,
    paymentId,
    expectedAmountPaise: intent.amount,
    expectedEventSlug:   intent.eventSlug,
    expectedPassId:      intent.passId,
    expectedPhone:       intent.attendee?.phone ?? '',
  })

  if (!outcome.ok) {
    // A refusal is a refusal — never a refund, and never a retry with looser inputs.
    await upsertReconciliationCase({
      orderId, organizerUid: intent.organizerUid, eventSlug: intent.eventSlug,
      eventName: intent.eventName ?? '', attendeeName: intent.attendee?.name ?? '',
      attendeePhone: intent.attendee?.phone ?? '', amountPaise: intent.amount,
      currency: intent.currency ?? 'INR', paymentState: 'captured', paymentId,
      status: 'requires_review', reason: outcome.reason,
    })
    return NextResponse.json({ ok: false, message: say(outcome.reason) }, { status: 409 })
  }

  const s = outcome.outcome
  const registrationId = 'registrationId' in s ? s.registrationId : null

  if (!registrationId) {
    await upsertReconciliationCase({
      orderId, organizerUid: intent.organizerUid, eventSlug: intent.eventSlug,
      eventName: intent.eventName ?? '', attendeeName: intent.attendee?.name ?? '',
      attendeePhone: intent.attendee?.phone ?? '', amountPaise: intent.amount,
      currency: intent.currency ?? 'INR', paymentState: 'captured', paymentId,
      status: 'requires_review', reason: `${s.kind}:${'reason' in s ? s.reason : 'unknown'}`,
    })
    return NextResponse.json({ ok: false, message: say(s.kind) }, { status: 409 })
  }

  // ── 7. Resolved ─────────────────────────────────────────────────────────────
  await upsertReconciliationCase({
    orderId, organizerUid: intent.organizerUid, eventSlug: intent.eventSlug,
    eventName: intent.eventName ?? '', attendeeName: intent.attendee?.name ?? '',
    attendeePhone: intent.attendee?.phone ?? '', amountPaise: intent.amount,
    currency: intent.currency ?? 'INR', paymentState: 'captured', paymentId,
    status: 'resolved', reason: 'recovered', registrationId,
  })

  // Read back only the ticket code, for the confirmation line. Best-effort: the registration
  // is already durable and its absence must not turn a success into an error.
  let ticketCode: string | undefined
  try {
    const reg = await adminDb.collection('registrations').doc(registrationId).get()
    const t = reg.data()?.ticketCode
    if (typeof t === 'string') ticketCode = t
  } catch { /* cosmetic only */ }

  return NextResponse.json({
    ok: true, registrationId, ticketCode,
    message: 'Registration recovered successfully.',
  })
}
