// POST /api/webhooks/cashfree — RD-PAYMENT-CASHFREE-SANDBOX-05. SANDBOX ONLY.
//
// ═══ A SEPARATE ENDPOINT, ON PURPOSE ═════════════════════════════════════════
// Razorpay keeps /api/webhooks/razorpay. This is its own route rather than a generic
// /api/webhooks/[provider] because a shared handler is how one provider's signature check
// ends up reachable with another provider's body: whoever posts first picks the verifier.
// Two endpoints, two secrets, two schemes, no negotiation.
//
// ═══ VERIFIED CASHFREE CONTRACT ══════════════════════════════════════════════
//   headers  x-webhook-signature · x-webhook-timestamp
//   signature base64(HMAC-SHA256(timestamp + rawBody, clientSecret))
//   body     { type, event_time, data: { order: {...}, payment: {...} } }
//   types    PAYMENT_SUCCESS_WEBHOOK | PAYMENT_FAILED_WEBHOOK |
//            PAYMENT_USER_DROPPED_WEBHOOK | PAYMENT_CHARGES_WEBHOOK
//
// ═══ WHAT THIS ROUTE DOES NOT DO ═════════════════════════════════════════════
// It does not create a registration. It normalizes a provider event and hands it to
// `settleCapturedRegistration` — the same function the Razorpay webhook, the browser
// callback and the recovery sweep use. There is exactly one place a registration is born,
// and adding a provider does not add a second.
//
// It also never refunds. Nothing automatic may (RD-PAYMENT-REFUND-AUTHORITY-02).

import { NextRequest, NextResponse } from 'next/server'
import { getPaymentIntent } from '@/lib/firebase/firestore/paymentIntents'
import { settleCapturedRegistration } from '@/lib/payments/settleCapturedRegistration'
import {
  verifyCashfreeWebhook, cashfreeWebhookSecret, rupeesToPaise, mapCashfreeStatus,
} from '@/lib/payments/providers/cashfreeAdapter'
import { isCashfreeEnabled } from '@/lib/payments/providers'
import { captureWebhookError } from '@/lib/monitoring/sentry'

export const dynamic = 'force-dynamic'

interface CashfreeWebhookBody {
  type?:       unknown
  event_time?: unknown
  data?: {
    order?:   { order_id?: unknown; order_amount?: unknown; order_currency?: unknown }
    payment?: {
      cf_payment_id?: unknown; payment_status?: unknown
      payment_amount?: unknown; payment_currency?: unknown
    }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 0. Disabled by default ─────────────────────────────────────────────────
  // 404, not 403: an endpoint that is not part of this deployment should not advertise that
  // it exists and is merely switched off.
  if (!isCashfreeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // ── 1. Raw body FIRST ──────────────────────────────────────────────────────
  // The signature covers the raw bytes. Parsing first and re-serialising would change
  // whitespace and decimal forms ("170.00" → 170) and every signature would fail — or
  // worse, a lenient re-serialisation would verify something other than what was sent.
  const rawBody   = await req.text()
  const signature = req.headers.get('x-webhook-signature') ?? ''
  const timestamp = req.headers.get('x-webhook-timestamp') ?? ''

  // ── 2. Verify BEFORE parsing, before any lookup, before any write ──────────
  // Note this is a plain synchronous call — but see
  // tests/unit/webhookSignatureAwaited.test.ts: if it ever becomes async, `!promise` is
  // always false and this guard silently accepts everything.
  if (!verifyCashfreeWebhook(rawBody, signature, timestamp, cashfreeWebhookSecret())) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let body: CashfreeWebhookBody
  try { body = JSON.parse(rawBody) as CashfreeWebhookBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const type = typeof body.type === 'string' ? body.type : ''

  // ── 3. Only a success event settles ────────────────────────────────────────
  // Everything else is acknowledged so Cashfree stops retrying a message we have correctly
  // decided to ignore. Acknowledging is not the same as acting: nothing below runs.
  if (type !== 'PAYMENT_SUCCESS_WEBHOOK') {
    return NextResponse.json({ received: true, ignored: type || 'unknown' })
  }

  const order   = body.data?.order
  const payment = body.data?.payment
  const orderId = typeof order?.order_id === 'string' ? order.order_id : ''
  const paymentId = payment?.cf_payment_id === undefined || payment?.cf_payment_id === null
    ? '' : String(payment.cf_payment_id)

  if (!orderId || !paymentId) {
    return NextResponse.json({ error: 'Missing order or payment identifier' }, { status: 400 })
  }

  // ── 4. The intent is the authority on what SHOULD have been paid ───────────
  const intent = await getPaymentIntent(orderId)
  if (!intent) {
    // Unknown order. Acknowledged rather than retried: replaying will not make an intent
    // appear, and a retry storm against an unknown id helps nobody. Reported so a genuine
    // orphan is visible instead of silently dropped.
    captureWebhookError('cashfree_unknown_order', {
      scope: 'cashfree.webhook.unknown_order', orderId, paymentId,
    })
    return NextResponse.json({ received: true, ignored: 'unknown_order' })
  }

  // ── 5. Binding checks — every one of these must match before money counts ──
  //
  // PROVIDER. A Cashfree-signed event against a Razorpay intent means the two disagree
  // about where the money is; neither may settle the other's order.
  if (intent.provider !== 'cashfree') {
    captureWebhookError('cashfree_provider_mismatch', {
      scope: 'cashfree.webhook.provider_mismatch', orderId, paymentId, intentProvider: intent.provider,
    })
    return NextResponse.json({ error: 'Provider mismatch' }, { status: 409 })
  }

  // STATUS. Only a real SUCCESS counts — the event type alone is not proof, because the
  // payload carries its own status and the two must agree.
  if (mapCashfreeStatus(payment?.payment_status) !== 'captured') {
    return NextResponse.json({ received: true, ignored: 'payment_not_successful' })
  }

  // CURRENCY, then AMOUNT. Parsed from the decimal-rupee form into integer paise and
  // compared against the intent's authoritative amount — never against anything the client
  // supplied. A mismatch is refused outright rather than settled for the wrong figure.
  const currency = typeof payment?.payment_currency === 'string' ? payment.payment_currency : 'INR'
  if (currency !== intent.currency) {
    captureWebhookError('cashfree_currency_mismatch', {
      scope: 'cashfree.webhook.currency_mismatch', orderId, paymentId, currency,
    })
    return NextResponse.json({ error: 'Currency mismatch' }, { status: 409 })
  }

  let amountPaise: number
  try { amountPaise = rupeesToPaise(payment?.payment_amount as string | number) }
  catch { return NextResponse.json({ error: 'Unparseable amount' }, { status: 400 }) }

  if (amountPaise !== intent.amount) {
    captureWebhookError('cashfree_amount_mismatch', {
      scope: 'cashfree.webhook.amount_mismatch', orderId, paymentId,
      expected: intent.amount, got: amountPaise,
    })
    return NextResponse.json({ error: 'Amount mismatch' }, { status: 409 })
  }

  // ── 6. The ONE settlement ──────────────────────────────────────────────────
  // Idempotency is the settlement's, not this route's: it re-reads the intent inside its
  // transaction, so a duplicate delivery returns `already_settled` and creates nothing. No
  // second dedupe table, and therefore no second thing that can disagree.
  const outcome = await settleCapturedRegistration({
    orderId, paymentId, intent, source: 'webhook',
  })

  if (outcome.kind === 'held') {
    captureWebhookError('cashfree_settlement_held', {
      scope: 'cashfree.webhook.held', orderId, paymentId, reason: outcome.reason,
      detail: 'captured payment held for Super Admin review — NOT refunded',
    })
  }

  // Always 2xx: every outcome above is either final or deliberately left for the recovery
  // sweep, and a non-2xx would make Cashfree retry against a state that will not change.
  return NextResponse.json({ received: true })
}
