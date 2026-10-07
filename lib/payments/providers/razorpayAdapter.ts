// RD-PAYMENT-PROVIDER-CONTRACT-04 · the Razorpay adapter — the ONLY place Razorpay's SDK
// shapes become RegisterDesk's.
//
// ═══ WHAT THIS DELIBERATELY IS NOT ═══════════════════════════════════════════
// It is not a rewrite. Every operation below is the existing call with the existing
// arguments; the signature helpers are the existing implementations moved, not reworked —
// same HEX_64 pre-check, same raw-Buffer HMAC, same timingSafeEqual. Behavioural parity for
// live Razorpay traffic is the requirement this phase is judged on, so the translation to
// normalized types happens AFTER the call and changes nothing about the call itself.
//
// ═══ STATUS MAPPING, AND THE ONE THAT MATTERS ════════════════════════════════
// Razorpay's payment statuses are `created | authorized | captured | refunded | failed`,
// which map one-to-one onto the normalized vocabulary. The mapping is still written out
// explicitly rather than cast, because an unknown status must become `failed` — the safe
// direction. Reading an unrecognised status as `captured` would settle a registration
// against money nobody has.

import crypto from 'crypto'
import { RAZORPAY_WEBHOOK_SECRET } from '@/lib/env'

// ═══ WHY THE CLIENT IS IMPORTED LAZILY ═══════════════════════════════════════
// `@/lib/razorpay/client` calls `required()` at module scope: importing it DEMANDS
// RAZORPAY_KEY_ID / _KEY_SECRET / _WEBHOOK_SECRET and throws without them. That is
// deliberate (see the note in that file) — it keeps a missing or test-mode key failing
// payment endpoints only, never OTP, dashboards or certificates.
//
// A top-level import here would defeat it. The provider registry imports this adapter, and
// anything that touches the registry — including reading a stored discriminator — would
// then require live gateway credentials just to load. The emulator carries none on purpose,
// so it would also make the payment modules untestable.
//
// So the client is required INSIDE the operations that actually call it. This mirrors
// lib/licensing/capacityChange.ts, which lazy-imports for exactly the same reason.
async function client() {
  return import('@/lib/razorpay/client')
}
import type {
  PaymentProviderAdapter,
  RefundProviderAdapter,
  NormalizedOrder,
  NormalizedPayment,
  NormalizedPaymentStatus,
  NormalizedRefund,
  CheckoutHandoff,
} from '@/lib/payments/providers/types'

// HMAC-SHA256 is always 32 bytes = 64 lowercase hex chars. Rejecting anything else BEFORE
// the comparison prevents length-extension games and stops timingSafeEqual throwing on a
// length mismatch. Carried over verbatim from the route implementations.
const HEX_64 = /^[0-9a-f]{64}$/

function timingSafeHexEqual(expectedHmac: Buffer, signature: string): boolean {
  if (!HEX_64.test(signature)) return false
  return crypto.timingSafeEqual(expectedHmac, Buffer.from(signature, 'hex'))
}

function mapStatus(raw: unknown): NormalizedPaymentStatus {
  switch (raw) {
    case 'created':    return 'created'
    case 'authorized': return 'authorized'
    case 'captured':   return 'captured'
    case 'refunded':   return 'refunded'
    case 'failed':     return 'failed'
    // Unknown means "we do not know that this money exists". `failed` is the only safe
    // reading: it never causes a registration to be settled.
    default:           return 'failed'
  }
}

interface RazorpayPaymentLike {
  id?: unknown; order_id?: unknown; status?: unknown
  amount?: unknown; currency?: unknown; created_at?: unknown
}

function toNormalizedPayment(p: RazorpayPaymentLike): NormalizedPayment {
  return {
    provider:          'razorpay',
    providerPaymentId: String(p.id ?? ''),
    providerOrderId:   typeof p.order_id === 'string' ? p.order_id : null,
    status:            mapStatus(p.status),
    amountPaise:       typeof p.amount === 'number' ? p.amount : Number(p.amount ?? 0),
    currency:          typeof p.currency === 'string' ? p.currency : 'INR',
    // Razorpay reports created_at in SECONDS. Normalizing to ms here is exactly the kind of
    // unit mismatch that must not be left for each caller to remember.
    capturedAtMs:      typeof p.created_at === 'number' ? p.created_at * 1000 : null,
  }
}

export const razorpayAdapter: PaymentProviderAdapter & RefundProviderAdapter = {
  id: 'razorpay',

  async createOrder({ amountPaise, currency, receipt }): Promise<NormalizedOrder> {
    const { razorpay, RAZORPAY_KEY_ID } = await client()
    const order = await razorpay.orders.create({ amount: amountPaise, currency, receipt })
    return {
      provider:        'razorpay',
      providerOrderId: order.id,
      amountPaise,
      currency,
      // RD-PAYMENT-CASHFREE-CHECKOUT-06 — the key id the browser already received from
      // create-order, now carried on the order itself so the route never has to name a
      // provider's field. This is the PUBLISHABLE key (rzp_*), the one Razorpay's own
      // checkout script takes in the browser; the secret never leaves the server.
      checkout: { provider: 'razorpay', keyId: RAZORPAY_KEY_ID },
    }
  },

  /** Configuration, not a lookup — Razorpay's checkout takes the publishable key and the order id. */
  async getCheckoutHandoff(): Promise<CheckoutHandoff> {
    const { RAZORPAY_KEY_ID } = await client()
    return { provider: 'razorpay', keyId: RAZORPAY_KEY_ID }
  },

  async fetchOrderPayments(providerOrderId): Promise<NormalizedPayment[]> {
    const { razorpay } = await client()
    const res = await razorpay.orders.fetchPayments(providerOrderId) as { items?: RazorpayPaymentLike[] }
    return (res.items ?? []).map(toNormalizedPayment)
  },

  async fetchPayment(providerPaymentId): Promise<NormalizedPayment | null> {
    const { razorpay } = await client()
    const p = await razorpay.payments.fetch(providerPaymentId) as RazorpayPaymentLike | null
    return p ? toNormalizedPayment(p) : null
  },

  async verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }): Promise<boolean> {
    const { RAZORPAY_KEY_SECRET } = await client()
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest()
    return timingSafeHexEqual(expected, signature)
  },

  async verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
    const expected = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest()
    return timingSafeHexEqual(expected, signature)
  },

  /**
   * Performs a refund. It does NOT decide whether one is permitted — see the note on
   * `RefundProviderAdapter`. Callers reach this only after `resolveSuperAdminUid`.
   */
  async refund({ providerPaymentId, amountPaise, reason, receipt }): Promise<NormalizedRefund> {
    const { razorpay } = await client()
    const r = await razorpay.payments.refund(providerPaymentId, {
      amount: amountPaise,
      speed:  'optimum',
      notes:  { reason },
      receipt,
    })
    return {
      provider:         'razorpay',
      providerRefundId: r.id,
      status:           String(r.status),
      amountPaise,
    }
  },
}
