// POST /api/razorpay/webhook
//
// Receives Razorpay webhook events and reconciles Firestore state.
//
// Security model
//   1. HMAC-SHA256 of the raw request body is verified against
//      X-Razorpay-Signature using RAZORPAY_WEBHOOK_SECRET.
//      Invalid signatures → 400, no processing, no audit entry.
//
// Idempotency model (two layers)
//   Layer 1 — event-level:  paymentEvents/{eventId} is created atomically
//             before any processing.  A duplicate event sees the existing doc
//             and returns 200 immediately without touching donation state.
//   Layer 2 — donation-level: donation.status is checked before calling
//             completeDonation(). If already 'successful', the event is
//             recorded as 'skipped' without re-incrementing counters.
//
// Note: a true transaction-level race guard would require modifying
// completeDonation() to check donation.status inside its own transaction.
// That improvement is deferred; the two-layer guard above makes simultaneous
// double-processing astronomically unlikely for normal traffic.
//
// Event types handled
//   payment.captured  → completeDonation() — issues receipt + updates counter
//   payment.failed    → failDonation()     — marks donation failed
//   refund.processed  → updates donation to 'refunded' + stores refund metadata
//   (any other)       → accepted and logged, no action

import crypto                  from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }          from 'firebase-admin/firestore'
import { adminDb }             from '@/lib/firebase/admin'
import { captureWebhookError } from '@/lib/monitoring/sentry'
import {
  getDonation,
} from '@/lib/firebase/firestore/donations'
import { getCampaignBySlug }   from '@/lib/firebase/firestore/campaigns'
import { isContentTakenDown }  from '@/lib/admin/moderation'
import {
  completeDonation,
  failDonation,
} from '@/lib/donations/donationService'
import { attemptForRefund, recordDonationRefundGatewayOutcome, settleDonationRefundOutcome } from '@/lib/donations/refundService'
import { extractActualGatewayFee, recordActualGatewayFee } from '@/lib/payments/actualGatewayFee'
import { logAdminActionOrRecord }      from '@/lib/admin/audit'
import { RazorpayDonationGateway }     from '@/lib/razorpay/donationGateway'
import { flagSuspiciousPayment }      from '@/lib/payments/flagSuspicious'
import { RAZORPAY_WEBHOOK_SECRET, RAZORPAY_KEY_SECRET } from '@/lib/env'

// Phase 3.1 — a delivery can never outlive STALE_PROCESSING_MS (a stale claim is re-claimable).
export const maxDuration = 60

// ─── Razorpay webhook payload types ──────────────────────────────────────────

interface RazorpayPaymentEntity {
  id:         string
  order_id:   string
  amount:     number
  currency:   string
  status:     string
  notes:      Record<string, string | undefined>
  error_code?:        string
  error_description?: string
}

interface RazorpayRefundEntity {
  id:         string
  payment_id: string
  amount:     number
  status:     string
  /** Phase 2.2 — RegisterDesk sends { donationId, reason, attemptId } in the refund's notes. */
  notes?:     Record<string, string | undefined>
}

/**
 * Phase 2.2 — a signed refund event naming a RegisterDesk refund ATTEMPT (notes.attemptId) resolves
 * that attempt to this refund id (idempotent; never re-points a linked attempt). Returns the attempt's
 * initiator when the refund belongs to one, so the record and the reservation stay owned by it.
 */
function warnIfAttemptConcluded(donationId: string, refund: RazorpayRefundEntity): void {
  // A refund for an attempt already concluded to have created none: a contradiction for a human (the
  // refund itself is still recorded exactly as the gateway reports it; the attempt is never re-pointed).
  void attemptForRefund(donationId, refund.notes?.attemptId).then(attempt => {
    if (attempt && (attempt.status === 'rejected' || attempt.status === 'resolved_none')) {
      captureWebhookError(new Error('refund event for an attempt resolved as no-refund'), { scope: 'razorpay.donation_webhook.attempt_conflict', donationId, attemptId: refund.notes?.attemptId, refundId: refund.id })
    }
  }).catch(() => {})
}

interface RazorpayWebhookBody {
  id:         string   // Razorpay event ID — used as paymentEvents doc ID
  event:      string
  created_at: number
  payload: {
    payment?: { entity: RazorpayPaymentEntity }
    refund?:  { entity: RazorpayRefundEntity  }
  }
}

// ─── paymentEvents document ───────────────────────────────────────────────────

type PaymentEventResult = 'processing' | 'processed' | 'skipped' | 'failed'

interface PaymentEventDocument {
  id:           string
  eventType:    string
  donationId:   string
  paymentId:    string
  orderId:      string
  rawPayload:   unknown
  receivedAt:   unknown
  processedAt?: unknown
  result:       PaymentEventResult
  resultDetail: string
  /** Phase 2 — the handler could not record durable state: the event may be claimed again (redelivery). */
  retryable?:   boolean
  attempts?:    number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
  try {
    const expected    = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')
    const expectedBuf = Buffer.from(expected,        'hex')
    const actualBuf   = Buffer.from(signatureHeader, 'hex')
    if (expectedBuf.length !== actualBuf.length) return false
    return crypto.timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}

// Compute the expected Razorpay payment signature so completeDonation() can
// verify it without receiving it from an untrusted source.
// This is safe: we've already verified the webhook; we're just reconstructing
// the deterministic HMAC that Razorpay would have sent to the browser.
function computePaymentSignature(orderId: string, paymentId: string): string {
  return crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
}

function eventRef(eventId: string) {
  return adminDb.collection('paymentEvents').doc(eventId)
}

/** Longer than any handler run (maxDuration below): a refund event still processing after this was abandoned. */
const STALE_PROCESSING_MS = 15 * 60_000

async function claimEventSlot(
  eventId:    string,
  eventType:  string,
  donationId: string,
  paymentId:  string,
  orderId:    string,
  rawPayload: unknown,
): Promise<'claimed' | 'duplicate'> {
  let outcome: 'claimed' | 'duplicate' = 'claimed'

  await adminDb.runTransaction(async txn => {
    const existing = await txn.get(eventRef(eventId))
    if (existing.exists) {
      // Phase 2 — a delivery whose handler failed BEFORE it could record durable state was released
      // for redelivery (retryable): re-claim it exactly once (this transaction serialises claimers).
      const prev = existing.data() as Partial<PaymentEventDocument>
      // Phase 3.1 — a REFUND event still 'processing' long after any handler could run (the process died
      // before writing anything durable) is claimed again too; a recent one is a concurrent duplicate.
      const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
      const receivedMs = Math.max(ms(prev.receivedAt), ms((prev as { reclaimedAt?: unknown }).reclaimedAt))   // the LATEST claim
      const staleProcessing = prev.result === 'processing' && eventType.startsWith('refund.') && receivedMs > 0 && Date.now() - receivedMs > STALE_PROCESSING_MS
      if ((prev.retryable === true && prev.result === 'failed') || staleProcessing) {
        txn.update(eventRef(eventId), { result: 'processing', resultDetail: '', retryable: false, attempts: FieldValue.increment(1), reclaimedAt: FieldValue.serverTimestamp() })
        return
      }
      outcome = 'duplicate'
      return
    }

    const doc: Omit<PaymentEventDocument, 'processedAt'> = {
      id:           eventId,
      eventType,
      donationId,
      paymentId,
      orderId,
      rawPayload,
      receivedAt:   FieldValue.serverTimestamp(),
      result:       'processing',
      resultDetail: '',
    }
    txn.set(eventRef(eventId), doc)
  })

  return outcome
}

async function finaliseEvent(
  eventId:      string,
  result:       Exclude<PaymentEventResult, 'processing'>,
  resultDetail: string,
  retryable = false,
): Promise<void> {
  await eventRef(eventId).update({
    result,
    resultDetail,
    retryable,
    processedAt: FieldValue.serverTimestamp(),
  })
}

// ─── payment.captured ─────────────────────────────────────────────────────────

async function handlePaymentCaptured(
  payment: RazorpayPaymentEntity,
  eventId: string,
): Promise<{ result: Exclude<PaymentEventResult, 'processing'>; detail: string }> {
  const donationId = payment.notes.donationId
  if (!donationId) {
    return { result: 'skipped', detail: 'no_donation_id_in_notes' }
  }

  const donation = await getDonation(donationId)
  if (!donation) {
    return { result: 'failed', detail: `donation_not_found:${donationId}` }
  }

  // ── The gateway fee, recorded BEFORE the idempotency return below ──────────
  // Deliberately above it. In the common case the browser verify path has already
  // completed the donation, so this handler returns "already_successful" at the next
  // block — which is exactly how the registration ledger ended up with zero actual fees
  // in production. The fee is independent of completion state, so it is captured here
  // regardless of whether this delivery completes anything.
  //
  // Same write-once primitive and the same deterministic `ptx_<id>` key the donation
  // ledger writes, so this only ever fills a gap and never creates a row. Awaited: work
  // left pending when a serverless response returns can be dropped.
  const donationFee = extractActualGatewayFee(payment as { fee?: unknown; tax?: unknown })
  if (donationFee) {
    await recordActualGatewayFee(`ptx_${donationId}`, donationFee, { paymentId: payment.id })
  }

  // Layer-2 idempotency: browser verify may have beaten us here
  if (donation.status === 'successful') {
    return { result: 'skipped', detail: 'already_successful' }
  }

  if (donation.status === 'failed') {
    return { result: 'skipped', detail: 'donation_already_failed' }
  }

  // ── Amount + currency + order verification (defense-in-depth) ──────────────
  // Verify the captured payment matches the donation recorded at order creation
  // BEFORE completing the donation / crediting the organizer wallet. Order is
  // verified when the donation stored an expected order id ("where applicable").
  // On mismatch: flag suspicious and do NOT complete the donation.
  if (
    payment.currency !== 'INR' ||
    payment.amount !== donation.amountPaise ||
    (donation.razorpayOrderId !== undefined && payment.order_id !== donation.razorpayOrderId)
  ) {
    await flagSuspiciousPayment({
      source: 'donation', reason: 'amount_or_order_mismatch',
      paymentId: payment.id, orderId: payment.order_id, entityId: donationId,
      expectedAmountPaise: donation.amountPaise, actualAmountPaise: payment.amount,
      expectedCurrency: 'INR', actualCurrency: payment.currency,
      expectedOrderId: donation.razorpayOrderId, actualOrderId: payment.order_id,
    })
    return {
      result: 'failed',
      detail: `amount_or_order_mismatch:expected=${donation.amountPaise}/${donation.razorpayOrderId ?? 'na'}:got=${payment.amount}/${payment.order_id}`,
    }
  }

  // Load campaign for is80G (not stored on donation doc)
  const campaign = await getCampaignBySlug(donation.campaignSlug)

  // Admin moderation — never complete (credit/receipt) a donation to a
  // taken-down campaign. Flag for manual refund; do not process.
  if (campaign && isContentTakenDown(campaign.moderationStatus)) {
    await flagSuspiciousPayment({
      source: 'donation', reason: 'campaign_taken_down',
      paymentId: payment.id, orderId: payment.order_id, entityId: donationId,
      actualAmountPaise: payment.amount, actualCurrency: payment.currency,
    })
    return { result: 'failed', detail: `campaign_taken_down:${donation.campaignSlug}` }
  }

  const is80G    = campaign?.campaignDetails.taxConfig.enabled ?? false
  const title    = campaign?.campaignDetails.basics.title ?? donation.campaignTitle

  const gateway = new RazorpayDonationGateway()

  await completeDonation(
    {
      donationId,
      razorpayOrderId:   payment.order_id,
      razorpayPaymentId: payment.id,
      // Reconstruct the deterministic HMAC so completeDonation()'s verifySignature
      // check passes. The webhook itself was already verified above.
      razorpaySignature: computePaymentSignature(payment.order_id, payment.id),
    },
    gateway,
    {
      campaignSlug:  donation.campaignSlug,
      campaignTitle: title,
      organizerUid:  donation.organizerUid,
      donorName:     donation.donorName,
      donorEmail:    donation.donorEmail,
      amountPaise:   donation.amountPaise,
      amountRupees:  donation.amountRupees,
      isAnonymous:   donation.isAnonymous,
      is80G,
    },
  )

  console.log(`[webhook] payment.captured: completed donation ${donationId}`)
  return { result: 'processed', detail: 'completed' }
}

// ─── payment.failed ───────────────────────────────────────────────────────────

async function handlePaymentFailed(
  payment: RazorpayPaymentEntity,
): Promise<{ result: Exclude<PaymentEventResult, 'processing'>; detail: string }> {
  const donationId = payment.notes.donationId
  if (!donationId) {
    return { result: 'skipped', detail: 'no_donation_id_in_notes' }
  }

  const donation = await getDonation(donationId)
  if (!donation) {
    return { result: 'failed', detail: `donation_not_found:${donationId}` }
  }

  // Already in a terminal state — don't overwrite successful donations
  if (donation.status === 'successful') {
    return { result: 'skipped', detail: 'donation_already_successful' }
  }
  if (donation.status === 'failed') {
    return { result: 'skipped', detail: 'already_failed' }
  }

  const failureReason = [
    payment.error_code,
    payment.error_description,
  ].filter(Boolean).join(': ') || 'Payment failed'

  await failDonation(donationId, donation.donationPaymentId, failureReason)

  console.log(`[webhook] payment.failed: marked donation ${donationId} failed — ${failureReason}`)
  return { result: 'processed', detail: `failed:${failureReason}` }
}

// ─── refund.processed ─────────────────────────────────────────────────────────

async function handleRefundProcessed(
  refund:  RazorpayRefundEntity,
  payment: RazorpayPaymentEntity,
): Promise<{ result: Exclude<PaymentEventResult, 'processing'>; detail: string }> {
  const donationId = payment.notes.donationId
  if (!donationId) {
    return { result: 'skipped', detail: 'no_donation_id_in_notes' }
  }

  const donation = await getDonation(donationId)
  if (!donation) {
    return { result: 'failed', detail: `donation_not_found:${donationId}` }
  }

  // Partial-refund aware + idempotent: ensure the immutable refund record exists
  // (keyed by the Razorpay refund id — shared with the organizer path), then
  // apply accounting exactly-once. Multiple deliveries / a prior organizer-side
  // apply are no-ops because applyDonationRefundAccounting gates on the refund
  // status. refund.amount is the GROSS amount of THIS refund (full or partial).
  // Phase 2 / 3.1 — refund.processed is TRUSTED evidence (a signed gateway event) that the money left. The
  // attempt link (notes.attemptId), the refund record and an ACCOUNTING-PENDING marker are written in ONE
  // transaction before accounting is attempted, so a crash anywhere after it is completed by the drain; an
  // accounting failure is recorded durably (bounded retries, then needs_review). If the outcome itself
  // cannot be recorded, this throws: the event is released for redelivery.
  warnIfAttemptConcluded(donationId, refund)
  const settled = await settleDonationRefundOutcome({
    donationId, refundId: refund.id, paymentId: refund.payment_id, amountPaise: refund.amount,
    gatewayStatus: 'processed', evidence: 'webhook_refund_processed', source: 'webhook',
    attemptId: refund.notes?.attemptId ?? null, initiatedBy: 'webhook',
  })
  if (settled.record === 'conflict') return { result: 'failed', detail: `refund_outcome_conflict:${refund.id}` }
  if (!settled.applied && settled.failure) {
    if (settled.failure.state === 'completed') return { result: 'processed', detail: `refunded:${refund.id}:applied_concurrently` }
    return { result: 'failed', detail: `refund_accounting_${settled.failure.state}:${refund.id}:attempt_${settled.failure.attempts}` }
  }
  const result = { applied: settled.applied, fullRefund: (await adminDb.collection('donationRefunds').doc(refund.id).get()).get('isFullRefund') === true }

  // RD-PHASE4-S4 · F10 — the actor is the SYSTEM (the gateway webhook), never the organizer: the
  // organizer did not act, and an organizer uid in the admin audit log misattributes a money
  // movement. Written only when THIS delivery applied the accounting, so a redelivery (or the
  // organizer-side path having applied it first) never adds a second row. Awaited; never throws.
  if (result.applied) {
    await logAdminActionOrRecord({
      adminUid:   'system:razorpay_webhook',
      actorRole:  'system',
      action:     'donation.refund_processed',
      entityType: 'donation',
      entityId:   donationId,
      metadata:   { refundId: refund.id, amountPaise: refund.amount, fullRefund: result.fullRefund, applied: result.applied, organizerUid: donation.organizerUid },
      correlation: { donationId, refundId: refund.id, paymentId: refund.payment_id, organizerUid: donation.organizerUid },
    })
  }

  console.log(`[webhook] refund.processed: donation ${donationId}, refundId=${refund.id}, applied=${result.applied}, full=${result.fullRefund}`)
  return { result: 'processed', detail: `refunded:${refund.id}:applied=${result.applied}` }
}

// ─── refund.failed (Phase 2.1) ────────────────────────────────────────────────

/**
 * The gateway reports THIS refund (its own id) FAILED. Signed, so it is trusted for this refund only —
 * never used to infer anything about another refund. Nothing is accounted, nothing is reversed, no
 * gateway call is made and no hold is lifted; a contradiction with a recorded success is flagged for
 * review (recordDonationRefundGatewayFailure).
 */
async function handleRefundFailed(
  refund:  RazorpayRefundEntity,
  payment: RazorpayPaymentEntity,
): Promise<{ result: Exclude<PaymentEventResult, 'processing'>; detail: string }> {
  const donationId = payment.notes.donationId
  if (!donationId) return { result: 'skipped', detail: 'no_donation_id_in_notes' }
  const donation = await getDonation(donationId)
  if (!donation) return { result: 'failed', detail: `donation_not_found:${donationId}` }
  const r = refund as RazorpayRefundEntity & { error_description?: string; error_reason?: string }
  warnIfAttemptConcluded(donationId, refund)
  const rr = await recordDonationRefundGatewayOutcome({
    donationId, refundId: refund.id, paymentId: refund.payment_id, amountPaise: refund.amount,
    gatewayStatus: 'failed', evidence: 'webhook_refund_processed', source: 'webhook',
    attemptId: refund.notes?.attemptId ?? null, failureReason: r.error_description ?? r.error_reason ?? null, initiatedBy: 'webhook',
  })
  const outcome = rr.record === 'created' ? 'recorded_new' : rr.record === 'updated' ? 'recorded' : rr.record === 'conflict' ? 'conflict' : 'duplicate'
  console.log(`[webhook] refund.failed: donation ${donationId}, refundId=${refund.id}, outcome=${outcome}`)
  return { result: outcome === 'conflict' ? 'failed' : 'processed', detail: `refund_failed:${refund.id}:${outcome}` }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Read raw body for signature verification before any JSON parsing
  const rawBody = Buffer.from(await req.arrayBuffer())

  const signatureHeader = req.headers.get('x-razorpay-signature') ?? ''
  if (!signatureHeader) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  if (!verifyWebhookSignature(rawBody, signatureHeader)) {
    console.warn('[webhook] Invalid Razorpay signature — rejected')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let body: RazorpayWebhookBody
  try {
    body = JSON.parse(rawBody.toString('utf-8')) as RazorpayWebhookBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const eventId   = body.id
  const eventType = body.event

  if (!eventId) {
    return NextResponse.json({ error: 'Missing event id' }, { status: 400 })
  }

  const payment = body.payload.payment?.entity
  const refund  = body.payload.refund?.entity

  const donationId = payment?.notes?.donationId ?? 'unknown'
  const paymentId  = payment?.id    ?? refund?.payment_id ?? ''
  const orderId    = payment?.order_id ?? ''

  // Layer-1 idempotency: atomic slot claim via Firestore transaction
  const claim = await claimEventSlot(
    eventId,
    eventType,
    donationId,
    paymentId,
    orderId,
    body,   // full payload stored as audit trail
  )

  if (claim === 'duplicate') {
    console.log(`[webhook] Duplicate event ${eventId} (${eventType}) — skipped`)
    return NextResponse.json({ received: true })
  }

  // Route by event type
  let outcome: { result: Exclude<PaymentEventResult, 'processing'>; detail: string }

  try {
    switch (eventType) {
      case 'payment.captured': {
        if (!payment) {
          outcome = { result: 'failed', detail: 'missing_payment_entity' }
          break
        }
        outcome = await handlePaymentCaptured(payment, eventId)
        break
      }

      case 'payment.failed': {
        if (!payment) {
          outcome = { result: 'failed', detail: 'missing_payment_entity' }
          break
        }
        outcome = await handlePaymentFailed(payment)
        break
      }

      case 'refund.processed': {
        if (!refund || !payment) {
          outcome = { result: 'failed', detail: 'missing_refund_or_payment_entity' }
          break
        }
        outcome = await handleRefundProcessed(refund, payment)
        break
      }

      case 'refund.failed': {
        if (!refund || !payment) {
          outcome = { result: 'failed', detail: 'missing_refund_or_payment_entity' }
          break
        }
        outcome = await handleRefundFailed(refund, payment)
        break
      }

      default: {
        // Accept unknown event types; Razorpay may add new events in future
        console.log(`[webhook] Unhandled event type: ${eventType}`)
        outcome = { result: 'skipped', detail: `unhandled_event_type:${eventType}` }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    captureWebhookError(err, { scope: 'razorpay.donation_webhook', eventType, eventId })
    outcome = { result: 'failed', detail: message }
    // Phase 2 — a refund.processed whose handler threw recorded NOTHING durable (no refund record, or
    // no recovery state): release the claim and answer 500 so Razorpay redelivers it.
    if (eventType === 'refund.processed' || eventType === 'refund.failed') {
      await finaliseEvent(eventId, outcome.result, outcome.detail, true).catch(() => {})
      return NextResponse.json({ received: false, retry: true }, { status: 500 })
    }
  }

  // Persist result to audit trail
  await finaliseEvent(eventId, outcome.result, outcome.detail)

  // Always 200 for Razorpay (non-200 triggers retries) — except the refund.processed case above.
  return NextResponse.json({ received: true })
}
