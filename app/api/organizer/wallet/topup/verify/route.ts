// POST /api/organizer/wallet/topup/verify
//
// Called by the client immediately after Razorpay checkout succeeds.
// Verifies the HMAC signature, then credits the organizer wallet.
//
// Body: { orderId, paymentId, signature }

import crypto                                       from 'crypto'
import { NextRequest, NextResponse }               from 'next/server'
import { captureFinancialError }                    from '@/lib/monitoring/sentry'
import { adminDb }                                 from '@/lib/firebase/admin'
import { authorizeWorkspace }                      from '@/lib/team/workspace'
import { organizerStatusGuard }                    from '@/lib/admin/organizerStatus'
import { atomicTopupCredit, getWalletBalance, TopupCreditError } from '@/lib/firebase/firestore/wallet'
import { persistWalletTopupReconciliation, recordDuplicateTopupPayment, recordTopupPaymentMismatch, isHeldReconciliationStatus } from '@/lib/wallet/topupReconciliation'
import { flagSuspiciousPayment }                   from '@/lib/payments/flagSuspicious'
import { razorpay, RAZORPAY_KEY_SECRET as KEY_SECRET } from '@/lib/razorpay/client'
import type { WalletTopupVerifyResponse }          from '@/types/events'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { sendOrganizerWhatsApp }                   from '@/lib/notifications/organizerWhatsApp'
import { runAfterResponse }                        from '@/lib/server/afterResponse'
import { notifyWalletRecharged }                   from '@/lib/notifications/inbox/notify'

const HEX_64 = /^[0-9a-f]{64}$/

interface TopupRecord {
  uid:         string
  amountPaise: number
  status:      string
  /** The payment the order was credited with (set by atomicTopupCredit). */
  paymentId?:  string
}

/** RD-WALLET-W1 — a stable machine-readable outcome alongside the existing response shape. */
type VerifyResponse = WalletTopupVerifyResponse & {
  code?: 'PAYMENT_NOT_CAPTURED' | 'DUPLICATE_PAYMENT' | 'NEEDS_REVIEW' | 'CREDIT_DEFERRED' | 'REVIEW_UNRECORDED'
}

export async function POST(req: NextRequest): Promise<NextResponse<VerifyResponse>> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  // ── Parse body ────────────────────────────────────────────────────────────────
  let orderId: string, paymentId: string, signature: string
  try {
    const body = await req.json() as Record<string, unknown>
    orderId   = String(body.orderId   ?? '')
    paymentId = String(body.paymentId ?? '')
    signature = String(body.signature ?? '')
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
  }

  // ── Verify HMAC signature ─────────────────────────────────────────────────────
  // Reject malformed signatures before any crypto to prevent length-extension
  // attacks and ensure timingSafeEqual receives equal-length buffers.
  if (!HEX_64.test(signature)) {
    return NextResponse.json({ success: false, error: 'Payment signature verification failed' }, { status: 400 })
  }

  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest()                           // raw Buffer — same length as actual

  const actual = Buffer.from(signature, 'hex')  // always 32 bytes after regex check

  if (!crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ success: false, error: 'Payment signature verification failed' }, { status: 400 })
  }

  // ── Load topup record ─────────────────────────────────────────────────────────
  const topupRef  = adminDb.collection('walletTopups').doc(orderId)
  const topupSnap = await topupRef.get()

  if (!topupSnap.exists) {
    return NextResponse.json({ success: false, error: 'Topup order not found' }, { status: 404 })
  }

  const topup = topupSnap.data() as TopupRecord

  // Ownership check
  if (topup.uid !== uid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // Fast-path idempotency — a replay of the payment this order was credited with needs no
  // gateway call. (A DIFFERENT payment on a credited order is examined below — W1.4.)
  if (topup.status === 'credited' && (!topup.paymentId || topup.paymentId === paymentId)) {
    const balance = await getWalletBalance(uid)
    return NextResponse.json({ success: true, newBalance: balance })
  }

  // ── Fetch the payment from the gateway (never trust the client) ─────────────────
  // The signature already proves the payment belongs to `orderId`. We additionally
  // fetch it and assert amount/currency/order match the stored intent — so a forged
  // client body can't credit a wrong amount, and a payment for another order can't be
  // swapped in. Mismatch → flag + refuse.
  let payment: { amount?: number; currency?: string; status?: string; order_id?: string }
  try {
    payment = await razorpay.payments.fetch(paymentId) as typeof payment
  } catch (err) {
    captureFinancialError(err, { scope: 'topup.payment_fetch_failed', paymentId })
    return NextResponse.json({ success: false, error: 'Could not verify payment. Please try again.' }, { status: 502 })
  }

  const matches =
    payment.currency === 'INR' &&
    payment.amount === topup.amountPaise &&
    payment.order_id === orderId

  // ── Already credited with a DIFFERENT payment (W1.4) ─────────────────────────────
  if (topup.status === 'credited') {
    // RD-WALLET-W1 · W1.4 — a different payment on an order that was already credited. Never
    // credited again, never reported as a success; recorded for Super Admin review.
    await recordDuplicateTopupPayment({
      orderId, uid, amountPaise: topup.amountPaise, paymentId,
      creditedPaymentId: topup.paymentId ?? null, source: 'verify', paymentStatus: payment.status,
    })
    return NextResponse.json({
      success: false, code: 'DUPLICATE_PAYMENT',
      error: 'This top-up was already paid and credited. Your additional payment was NOT added to the wallet and has been flagged for review — please do not pay again.',
    } satisfies VerifyResponse, { status: 409 })
  }

  // RD-WALLET-W2.c · D6 — a CAPTURED payment on THIS order whose amount or currency does not match
  // is money that exists and must not be credited: recorded DURABLY for Super Admin review with the
  // W2.b recorder (idempotent per payment — shared with the webhook and the sweep — flagged once).
  // Same response as before once it is durable; a retryable 503 when it is not.
  if (!matches && payment.status === 'captured' && payment.order_id === orderId) {
    captureFinancialError('wallet_topup_amount_mismatch', { scope: 'topup.verify_mismatch', orderId, expected: topup.amountPaise, got: payment.amount, currency: payment.currency })
    const recorded = await recordTopupPaymentMismatch({
      orderId, uid, paymentId,
      expectedAmountPaise: topup.amountPaise,
      observedAmountPaise: typeof payment.amount === 'number' ? payment.amount : null,
      expectedCurrency:    'INR',
      observedCurrency:    typeof payment.currency === 'string' ? payment.currency : null,
      source:              'verify',
    })
    // W2.c fix 4 — the status codes are unchanged (400 recorded / 503 not recorded); the body now
    // says what is true: the payment is held for review, it is NOT credited automatically.
    return recorded
      ? NextResponse.json({
          success: false, code: 'NEEDS_REVIEW',
          error: 'Your payment was received, but its amount or currency does not match this top-up, so it was NOT added to your wallet. It has been sent for review — please do not pay again.',
        } satisfies VerifyResponse, { status: 400 })
      : NextResponse.json({
          success: false, code: 'REVIEW_UNRECORDED',
          error: 'Your payment was received, but it could not be matched to this top-up and was NOT added to your wallet. We could not finish sending it for review — please contact support with your payment reference, and do not pay again.',
        } satisfies VerifyResponse, { status: 503 })
  }

  if (!matches || (payment.status !== 'captured' && payment.status !== 'authorized')) {
    await flagSuspiciousPayment({
      source: 'wallet_topup', reason: 'amount_or_order_mismatch',
      paymentId, orderId, entityId: uid,
      expectedAmountPaise: topup.amountPaise, actualAmountPaise: payment.amount,
      expectedCurrency: 'INR', actualCurrency: payment.currency,
      expectedOrderId: orderId, actualOrderId: payment.order_id,
    })
    return NextResponse.json({ success: false, error: 'Payment verification failed.' }, { status: 400 })
  }

  // RD-WALLET-W1 · W1.1 — an AUTHORIZED payment is not money yet (the same rule the licensing
  // confirm routes follow, RD-F1). Nothing is credited here; the payment.captured webhook (or
  // the reconciliation cron, which re-verifies capture) credits it exactly once when it is
  // captured.
  if (payment.status === 'authorized') {
    return NextResponse.json({
      success: false, pending: true, code: 'PAYMENT_NOT_CAPTURED',
      error: 'Your payment is authorised but not yet captured, so your wallet has not been credited yet. It will be credited automatically once the payment is captured — please do not pay again.',
    } satisfies VerifyResponse, { status: 202 })
  }

  // ── Atomic credit + status + ledger (one transaction; idempotent) ──────────────
  // A transient failure here must NOT lose the captured payment: record a
  // reconciliation entry and report the credit as pending. The cron (and the
  // payment.captured webhook) will complete it exactly-once.
  try {
    const { newBalance, credited, creditedPaymentId } = await atomicTopupCredit(uid, topup.amountPaise, topupRef, paymentId)

    // Lost a race with another path that credited this order with a DIFFERENT payment.
    if (!credited && creditedPaymentId && creditedPaymentId !== paymentId) {
      await recordDuplicateTopupPayment({
        orderId, uid, amountPaise: topup.amountPaise, paymentId,
        creditedPaymentId, source: 'verify', paymentStatus: payment.status,
      })
      return NextResponse.json({
        success: false, code: 'DUPLICATE_PAYMENT',
        error: 'This top-up was already paid and credited. Your additional payment was NOT added to the wallet and has been flagged for review — please do not pay again.',
      } satisfies VerifyResponse, { status: 409 })
    }

    // Wallet Recharge — organizer Email + WhatsApp (FREE, Phase G3.5). Only on the
    // real credit (not an idempotent replay). Best-effort; never blocks the response.
    if (credited) {
      // Scheduled with after() (lib/server/afterResponse) — a detached promise is frozen with the response.
      await runAfterResponse(`wallet-recharged-notify ${topupRef.id}`, async () => {
        try {
          const userSnap = await adminDb.collection('users').doc(uid).get()
          const u = userSnap.data() as { email?: string; name?: string } | undefined
          if (!u?.email) return
          if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
            await notificationEngine.send(NotificationType.WALLET_RECHARGED, {
              to: u.email, organizerName: u.name ?? '', amountPaise: topup.amountPaise, newBalancePaise: newBalance,
            })
          }
          await sendOrganizerWhatsApp({
            type: NotificationType.WALLET_RECHARGED, organizerUid: uid,
            variables: { organizerName: u.name ?? '', amount: `₹${(topup.amountPaise / 100).toLocaleString('en-IN')}` },
          })
        } catch (err) {
          console.error('[wallet] recharge notification failed:', err)
        }
      })

      // H.4.3: record in the organizer Notification Center inbox (best-effort).
      void notifyWalletRecharged({ workspaceUid: uid, amountPaise: topup.amountPaise, newBalancePaise: newBalance, topupId: topupRef.id })
    }

    return NextResponse.json({ success: true, newBalance })
  } catch (err) {
    // RD-WALLET-W1 · W1.2 — a refusal is not transient: never retried, held for review.
    const refused = err instanceof TopupCreditError
    if (refused) captureFinancialError(err, { scope: 'topup.credit_refused', orderId, code: err.code })
    const rec = await persistWalletTopupReconciliation({
      orderId, uid, amountPaise: topup.amountPaise, paymentId,
      error: err instanceof Error ? err.message : 'credit_failed',
      status: refused ? 'needs_review' : 'pending',
      ...(refused ? { refusal: err.code } : {}),
    })
    // RD-WALLET-W2.c — one flag per (refusal, payment); a repeated verify adds no new evidence.
    if (refused && rec.newEvidence) {
      await flagSuspiciousPayment({
        source: 'wallet_topup', reason: `credit_refused:${err.code}`,
        paymentId, orderId, entityId: uid,
        expectedAmountPaise: topup.amountPaise, actualAmountPaise: payment.amount,
        expectedCurrency: 'INR', actualCurrency: payment.currency,
      })
    }
    const recorded = rec.persisted
    // RD-WALLET-W2.c — a transient failure on an order whose record is a HOLD (e.g. the hold check
    // itself could not be read, but the record could): the payment is awaiting review, not
    // "credited shortly".
    if (!refused && recorded && isHeldReconciliationStatus(rec.status)) {
      return NextResponse.json({
        success: false, code: 'NEEDS_REVIEW',
        error: 'Your payment was received but has not been credited — it is awaiting review. Please do not pay again.',
      } satisfies VerifyResponse, { status: 409 })
    }
    if (refused) {
      // RD-WALLET-W2.c — a refusal (e.g. a LATE payment on an abandoned order, or one of several
      // captured payments on a held order) is only "sent for review" once that is durable.
      if (!recorded) {
        return NextResponse.json({
          success: false, code: 'REVIEW_UNRECORDED',
          error: 'Your payment was received, but it could not be matched to this top-up and was NOT added to your wallet. We could not finish sending it for review — please contact support with your payment reference, and do not pay again.',
        } satisfies VerifyResponse, { status: 503 })
      }
      return NextResponse.json({
        success: false, code: 'NEEDS_REVIEW',
        error: 'Your payment was received but could not be matched to this top-up automatically. It has been sent for review — please do not pay again.',
      } satisfies VerifyResponse, { status: 409 })
    }
    // RD-WALLET-W1 · W1.3 — never claim a durable follow-up that was not recorded. When the
    // record did not persist either, the payment.captured webhook is the remaining recovery
    // (it retries until it can record or credit), so the organizer is told honestly.
    return NextResponse.json(
      recorded
        ? { success: false, pending: true, error: 'Payment received — your wallet will be credited shortly.' }
        : { success: false, pending: true, code: 'CREDIT_DEFERRED', error: 'Payment received, but we could not confirm your wallet credit right now, so it has not been credited yet. Please do not pay again — it will be completed or sent for review, and you can contact support with your payment reference if your balance has not updated soon.' },
      { status: recorded ? 202 : 503 },
    )
  }
}
