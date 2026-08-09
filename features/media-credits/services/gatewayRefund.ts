// MC-05 · Gateway refund execution — SERVER ONLY.
//
// The ONE place Media Credits talks to Razorpay about money going out. Nothing else in the
// module calls `payments.refund`.
//
// ═══ WHY IDEMPOTENCY NEEDS A GATEWAY READ ════════════════════════════════════
// Razorpay's refund API has no idempotency-key parameter. Calling it twice creates TWO
// refunds and pays the organizer twice — real money, unrecoverable without a support case.
//
// A stored `gatewayRefundId` guard is necessary but NOT sufficient: the dangerous window is
// exactly when the create call succeeded at Razorpay and the response never reached us, so
// nothing was stored. A retry then sees a null id and pays again.
//
// So before creating anything, this asks Razorpay what refunds already exist on the payment
// and looks for one tagged with our refundId. That tag is written into `notes` on creation,
// which makes the pairing durable on Razorpay's side rather than only on ours.
//
// ═══ ON THE MC-04 HMAC HELPER ════════════════════════════════════════════════
// It does not apply here. `verifyRazorpaySignature` verifies a Checkout signature the
// BROWSER returns; a refund is initiated server-to-server and Razorpay returns no such
// signature. The only refund-related HMAC would be a webhook signature — a different secret
// over a raw body — and MC-05 does not implement refund webhooks.

import { razorpay } from '@/lib/razorpay/client'
import { captureFinancialError } from '@/lib/monitoring/sentry'

/** The note key carrying our refundId into Razorpay, so a retry can recognise its own work. */
export const REFUND_TAG = 'mediaCreditRefundId'

export interface RefundPaymentInput {
  /** Our refund id. Becomes the gateway tag and the idempotency anchor. */
  refundId:    string
  paymentId:   string
  amountPaise: number
}

export interface RefundPaymentResult {
  gatewayRefundId: string
  /** True when an existing refund was adopted rather than a new one created. */
  reused:          boolean
  response:        Record<string, unknown>
}

interface GatewayRefund {
  id?:     unknown
  notes?:  Record<string, unknown>
  amount?: unknown
  status?: unknown
}

/** Trimmed to the fields worth keeping. The raw payload can carry unbounded gateway detail. */
function summarise(r: GatewayRefund): Record<string, unknown> {
  return {
    id:     typeof r.id === 'string' ? r.id : null,
    amount: typeof r.amount === 'number' ? r.amount : null,
    status: typeof r.status === 'string' ? r.status : null,
  }
}

/**
 * Refunds a payment, at most once per `refundId`.
 *
 * Retry-safe: call it as many times as you like for one refundId and the organizer is paid
 * exactly once. Throws on genuine gateway failure so the caller can leave the refund
 * `approved` for the reconciler; it never swallows an error into a false success.
 */
export async function refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
  const { refundId, paymentId, amountPaise } = input

  if (!paymentId) throw new Error('Cannot refund: the purchase has no payment reference.')
  if (amountPaise <= 0) throw new Error('Cannot refund a non-positive amount.')

  // ── 1. Has this refund already been issued? ────────────────────────────────
  // A read failure here is NOT fatal on its own, but proceeding would risk a double payout,
  // so it is treated as fatal. Better a retry than a duplicate refund.
  let existing: GatewayRefund | undefined
  try {
    const list = await razorpay.payments.fetchMultipleRefund(paymentId)
    const items = (list as { items?: GatewayRefund[] }).items ?? []
    existing = items.find(r => r.notes?.[REFUND_TAG] === refundId)
  } catch (err) {
    captureFinancialError(err, {
      scope: 'media_credits.refund_precheck_failed', refundId, paymentId,
    })
    throw new Error('Could not confirm refund state with the payment gateway.')
  }

  if (existing && typeof existing.id === 'string') {
    return { gatewayRefundId: existing.id, reused: true, response: summarise(existing) }
  }

  // ── 2. Create it, tagged so step 1 can find it next time ───────────────────
  const created = await razorpay.payments.refund(paymentId, {
    amount: amountPaise,
    speed:  'optimum',
    notes:  { [REFUND_TAG]: refundId, purpose: 'media_credits' },
    receipt: `mcr_${refundId.slice(-12)}`.slice(0, 40),
  }) as GatewayRefund

  if (typeof created.id !== 'string') {
    throw new Error('Payment gateway returned no refund id.')
  }

  return { gatewayRefundId: created.id, reused: false, response: summarise(created) }
}
