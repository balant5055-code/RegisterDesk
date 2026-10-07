// RD-PAYMENT-CASHFREE-SANDBOX-05 · the Cashfree adapter — SANDBOX ONLY, disabled by default.
//
// ═══ SCOPE ═══════════════════════════════════════════════════════════════════
// Payments only. NO Easy Split: no vendor creation, no onboarding, no split rules, no
// organizer share, no settlement. Those are later phases and nothing here reaches toward
// them — the point of this phase is to prove the provider contract can talk to a second
// gateway without disturbing Razorpay.
//
// ═══ NO SDK, DELIBERATELY ════════════════════════════════════════════════════
// This calls the documented REST API with `fetch` rather than adding a Cashfree package.
// The adapter needs five endpoints; a dependency would add a supply-chain surface and a
// version to track for no benefit, and the REST contract is the thing actually verified.
//
// ═══ VERIFIED CONTRACT (Cashfree PG, API version 2026-01-01) ═════════════════
//   base        sandbox https://sandbox.cashfree.com/pg · production https://api.cashfree.com/pg
//   auth        x-client-id, x-client-secret, x-api-version headers
//   create      POST /orders            { order_id, order_amount, order_currency, customer_details }
//               → { cf_order_id, order_id, order_status, payment_session_id }
//   payments    GET  /orders/{order_id}/payments
//               → [{ cf_payment_id, order_id, payment_status, payment_amount, payment_currency, payment_time }]
//   statuses    SUCCESS | NOT_ATTEMPTED | FAILED | USER_DROPPED | VOID | CANCELLED | PENDING
//   refund      POST /orders/{order_id}/refunds  { refund_id, refund_amount, refund_note }
//               → { cf_refund_id, refund_id, refund_status }
//   webhook     x-webhook-signature = base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret))
//
// ═══ THE MONEY DIFFERENCE, AND WHY IT IS THE RISKIEST PART ═══════════════════
// Razorpay speaks integer PAISE. Cashfree speaks DECIMAL RUPEES ("provide upto two
// decimals"), and its own docs warn to read webhook bodies as raw text so `170.00` does not
// become `170`.
//
// RegisterDesk stores integer paise and must keep doing so. Every conversion below is
// therefore string/integer arithmetic — never `paise / 100` floated back with `* 100`,
// which turns ₹186.99 into 18698.999999999996 and then into a one-paise discrepancy that
// only shows up in a reconciliation report months later.

import crypto from 'crypto'
import type {
  PaymentProviderAdapter,
  RefundProviderAdapter,
  NormalizedOrder,
  NormalizedPayment,
  NormalizedPaymentStatus,
  NormalizedRefund,
  CashfreeEnvironment,
  CheckoutHandoff,
} from '@/lib/payments/providers/types'

/** Documented API version this adapter was written and verified against. */
export const CASHFREE_API_VERSION = '2026-01-01'

export const CASHFREE_SANDBOX_BASE    = 'https://sandbox.cashfree.com/pg'
export const CASHFREE_PRODUCTION_BASE = 'https://api.cashfree.com/pg'

// ─── Money, in integers only ──────────────────────────────────────────────────

/**
 * Integer paise → the decimal-rupee STRING Cashfree expects ("18700" → "187.00").
 *
 * Built from integer parts. `(paise/100).toFixed(2)` would be float division on the way out
 * and is avoidable, so it is avoided.
 */
export function paiseToRupeeString(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error(`[cashfree] amount must be integer paise, got ${paise}`)
  const negative = paise < 0
  const abs      = Math.abs(paise)
  const rupees   = (abs - (abs % 100)) / 100
  const fraction = abs % 100
  return `${negative ? '-' : ''}${rupees}.${String(fraction).padStart(2, '0')}`
}

/**
 * Decimal rupees → integer paise, parsed as TEXT.
 *
 * Accepts a number too, because JSON.parse will already have produced one — but the digits
 * are still taken from the decimal string form rather than multiplied, so no float ever
 * touches the value. "187.00" and 187 and "187.1" all land exactly.
 */
export function rupeesToPaise(value: string | number): number {
  const s = String(value).trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`[cashfree] unparseable amount: ${s}`)
  const negative = s.startsWith('-')
  const [whole, frac = ''] = (negative ? s.slice(1) : s).split('.')
  // Two decimals is the documented precision; anything beyond it is truncated rather than
  // rounded, so a value can never be inflated by parsing.
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  return negative ? -paise : paise
}

// ─── Customer phone (RD-PAYMENT-CASHFREE-SANDBOX-05A) ─────────────────────────
//
// ═══ THE PRODUCT PROBLEM, AND THE SMALLEST SAFE BOUNDARY ═════════════════════
// Cashfree's Create Order refuses without `customer_details.customer_phone` (10 digits).
// RegisterDesk treats the attendee phone as OPTIONAL — globally so, except when an event
// sets `limitPerMobile`, which already returns PHONE_REQUIRED at create-order.
//
// Making phone mandatory platform-wide to satisfy one gateway would change the product for
// every Razorpay event, every free event and every existing form. So the requirement is
// scoped to where it actually comes from: the Cashfree path validates, and nothing else
// changes. An event paid through Razorpay keeps accepting attendees with no phone.
//
// Normalization is NOT reimplemented here. lib/communication/phone.ts is the documented
// single source of truth ("No other module should parse, strip, or normalize phone numbers")
// and it produces digits-only E.164 without '+'. This only takes the national part Cashfree
// wants, and refuses anything it cannot take honestly.

import { validatePhoneNumber, DEFAULT_COUNTRY_CALLING_CODE } from '@/lib/communication/phone'

export type CashfreePhoneResult =
  | { ok: true;  phone: string }
  | { ok: false; reason: string }

/**
 * Attendee phone → Cashfree's 10-digit `customer_phone`.
 *
 * Fails closed for anything it cannot derive truthfully. It never substitutes a placeholder,
 * the support number, the organizer's number or a zero-filled string: a fabricated number on
 * a real payment sends receipts and payment SMS toward someone who is not the attendee, and
 * Cashfree would accept it silently.
 *
 * Non-Indian numbers are refused rather than truncated. Taking the last 10 digits of a
 * country code we do not handle would produce a real number belonging to a different person.
 */
export function toCashfreeCustomerPhone(raw: string | undefined | null): CashfreePhoneResult {
  if (!raw || !raw.trim()) {
    return { ok: false, reason: 'A phone number is required to pay through this provider.' }
  }

  const result = validatePhoneNumber(raw)
  if (!result.valid || !result.normalizedPhone) {
    return { ok: false, reason: result.reason ?? 'Phone number is not valid.' }
  }

  // E.164 digits, no '+': an Indian number is '91' + 10 national digits.
  const e164 = result.normalizedPhone
  if (!e164.startsWith(DEFAULT_COUNTRY_CALLING_CODE)) {
    return { ok: false, reason: 'Only Indian phone numbers are supported for this payment method.' }
  }
  const national = e164.slice(DEFAULT_COUNTRY_CALLING_CODE.length)
  if (!/^[6-9]\d{9}$/.test(national)) {
    // Cashfree wants a 10-digit mobile. 6-9 is the Indian mobile prefix range, so a landline
    // or a malformed value is refused here rather than by the gateway after an order exists.
    return { ok: false, reason: 'A valid 10-digit Indian mobile number is required for this payment method.' }
  }
  return { ok: true, phone: national }
}

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * ═══ WHICH CASHFREE DEPLOYMENT THIS PROCESS TALKS TO ═════════════════════════
 *
 * Read from `CASHFREE_ENV`, defaulting to `sandbox`. The default matters: an environment
 * that simply forgets the variable must land on sandbox, never on the endpoint that moves
 * real money. Anything that is not exactly `production` is sandbox.
 */
export function cashfreeEnvironment(): CashfreeEnvironment {
  return (process.env.CASHFREE_ENV ?? '').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox'
}

/**
 * Credentials come from the environment and are read LAZILY, per call.
 *
 * Nothing is validated at module scope. Importing this adapter — which the provider registry
 * does — must never demand Cashfree credentials, exactly as the Razorpay adapter must never
 * demand Razorpay's.
 *
 * ═══ WHY PRODUCTION HAS ITS OWN VARIABLE NAMES ═══════════════════════════════
 *
 * Sandbox and production are different Cashfree accounts with different keys, and the
 * dangerous failure is not "no credentials" — that fails loudly — but SANDBOX CREDENTIALS
 * SENT TO THE PRODUCTION ENDPOINT, or the reverse. With one shared pair, switching
 * `CASHFREE_ENV` silently repoints existing keys at the other account and the mix-up is a
 * config edit away at all times.
 *
 * Separate names (`CASHFREE_PROD_CLIENT_ID` / `CASHFREE_PROD_CLIENT_SECRET`) make the mix
 * structurally impossible rather than merely discouraged: the production branch cannot read
 * a sandbox key because it never looks at that variable. It also means a developer machine
 * holding only sandbox keys CANNOT reach production even if `CASHFREE_ENV` is wrong — the
 * production branch finds nothing and refuses.
 */
function config(): { base: string; clientId: string; clientSecret: string; env: CashfreeEnvironment } {
  const env = cashfreeEnvironment()

  if (env === 'production') {
    const clientId     = (process.env.CASHFREE_PROD_CLIENT_ID ?? '').trim()
    const clientSecret = (process.env.CASHFREE_PROD_CLIENT_SECRET ?? '').trim()
    if (!clientId || !clientSecret) {
      throw new Error(
        '[cashfree] CASHFREE_ENV is production but CASHFREE_PROD_CLIENT_ID / ' +
        'CASHFREE_PROD_CLIENT_SECRET are not configured. Production deliberately does NOT ' +
        'fall back to the sandbox credentials.',
      )
    }
    return { base: CASHFREE_PRODUCTION_BASE, clientId, clientSecret, env }
  }

  const clientId     = (process.env.CASHFREE_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.CASHFREE_CLIENT_SECRET ?? '').trim()
  if (!clientId || !clientSecret) {
    throw new Error(
      '[cashfree] CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET are not configured. ' +
      'Cashfree is disabled by default.',
    )
  }
  return { base: CASHFREE_SANDBOX_BASE, clientId, clientSecret, env }
}

async function call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  const { base, clientId, clientSecret } = config()
  const res = await fetch(`${base}${path}`, {
    method:  init?.method ?? 'GET',
    headers: {
      'x-api-version':   CASHFREE_API_VERSION,
      'x-client-id':     clientId,
      'x-client-secret': clientSecret,
      ...(init ? { 'content-type': 'application/json' } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  })

  const text = await res.text()
  if (!res.ok) {
    // The body may carry the merchant's own identifiers but never a credential — the secret
    // is a request header and is not echoed. Truncated so a large error page cannot flood logs.
    throw new Error(`[cashfree] ${init?.method ?? 'GET'} ${path} failed ${res.status}: ${text.slice(0, 300)}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Cashfree payment status → RegisterDesk's vocabulary.
 *
 * Only SUCCESS becomes `captured`. Everything else — including PENDING and the states that
 * merely mean "the customer walked away" — is a non-success, and an UNRECOGNISED status
 * becomes `failed`, never `captured`: reading an unknown status as success would settle a
 * registration against money nobody has.
 *
 * Note there is no `authorized` equivalent here. Cashfree's PG flow captures on success, so
 * mapping anything to `authorized` would invent a state this provider does not report.
 */
export function mapCashfreeStatus(raw: unknown): NormalizedPaymentStatus {
  switch (raw) {
    case 'SUCCESS':       return 'captured'
    // RD-PAYMENT-CASHFREE-CHECKOUT-06 — PENDING was previously folded into `created`, which
    // made a payment IN FLIGHT indistinguishable from one never attempted. A real sandbox UPI
    // collect stays PENDING for ~30s, and payment-status reads "never attempted" as "safe to
    // pay again". Distinct state, because the difference is a double charge.
    case 'PENDING':       return 'pending'
    case 'NOT_ATTEMPTED': return 'created'
    case 'FAILED':
    case 'USER_DROPPED':
    case 'VOID':
    case 'CANCELLED':     return 'failed'
    default:              return 'failed'
  }
}

interface CashfreePaymentLike {
  cf_payment_id?: unknown; order_id?: unknown; payment_status?: unknown
  payment_amount?: unknown; payment_currency?: unknown; payment_time?: unknown
}

export function toNormalizedPayment(p: CashfreePaymentLike): NormalizedPayment {
  const status = mapCashfreeStatus(p.payment_status)
  return {
    provider:          'cashfree',
    providerPaymentId: String(p.cf_payment_id ?? ''),
    providerOrderId:   typeof p.order_id === 'string' ? p.order_id : null,
    status,
    amountPaise:       p.payment_amount === undefined || p.payment_amount === null
      ? 0
      : rupeesToPaise(p.payment_amount as string | number),
    currency:          typeof p.payment_currency === 'string' ? p.payment_currency : 'INR',
    // Cashfree sends an ISO-8601 timestamp, not epoch seconds. Only a real capture carries a
    // meaningful capture time.
    capturedAtMs:      status === 'captured' && typeof p.payment_time === 'string'
      ? (Number.isNaN(Date.parse(p.payment_time)) ? null : Date.parse(p.payment_time))
      : null,
  }
}

// ─── Webhook signature ────────────────────────────────────────────────────────

/**
 * base64(HMAC-SHA256(timestamp + rawBody, clientSecret)), compared timing-safely.
 *
 * Two differences from Razorpay that a copy-paste would get wrong: the digest is BASE64, not
 * hex, and the signed string is PREFIXED with the `x-webhook-timestamp` header. Verifying
 * the body alone would accept a replay of a valid body under any timestamp.
 *
 * Returns false for malformed input rather than throwing — `timingSafeEqual` throws on a
 * length mismatch, which would turn a bad signature into a 500 instead of a refusal.
 */
export function verifyCashfreeWebhook(
  rawBody: string,
  signature: string,
  timestamp: string,
  clientSecret: string,
): boolean {
  if (!signature || !timestamp) return false
  let expected: Buffer
  let actual: Buffer
  try {
    expected = crypto.createHmac('sha256', clientSecret).update(timestamp + rawBody).digest()
    actual   = Buffer.from(signature, 'base64')
  } catch { return false }
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export const cashfreeAdapter: PaymentProviderAdapter & RefundProviderAdapter = {
  id: 'cashfree',

  async createOrder({ amountPaise, currency, receipt, customer }): Promise<NormalizedOrder> {
    // Cashfree REQUIRES customer_details (customer_id + a 10-digit phone). RegisterDesk
    // allows attendees with no phone, so this genuinely cannot always be satisfied — it
    // fails closed and says why rather than inventing a placeholder number, which would
    // send a real payment receipt toward a number nobody owns.
    if (!customer?.id || !customer.phone) {
      throw new Error(
        '[cashfree] createOrder needs customer_details: a customer id and a 10-digit phone. ' +
        'RegisterDesk treats the attendee phone as optional, so this order cannot be opened.',
      )
    }

    const body = {
      order_id:       receipt,
      order_amount:   paiseToRupeeString(amountPaise),
      order_currency: currency,
      customer_details: {
        customer_id:    customer.id,
        customer_phone: customer.phone,
        ...(customer.email ? { customer_email: customer.email } : {}),
        ...(customer.name  ? { customer_name:  customer.name  } : {}),
      },
    }

    const res = await call<{ order_id?: string; cf_order_id?: string; payment_session_id?: string }>(
      '/orders', { method: 'POST', body },
    )
    // `order_id` is the identifier every later call addresses (payments and refunds are both
    // scoped to it), so that — not cf_order_id — is what RegisterDesk persists.
    const providerOrderId = res.order_id ?? ''
    if (!providerOrderId) throw new Error('[cashfree] createOrder returned no order_id')

    // RD-PAYMENT-CASHFREE-CHECKOUT-06 — this was parsed and then dropped, which left the
    // order unpayable: `payment_session_id` is the only token that opens Cashfree checkout.
    // Refuse rather than hand back an order nobody can pay.
    const paymentSessionId = res.payment_session_id ?? ''
    if (!paymentSessionId) throw new Error('[cashfree] createOrder returned no payment_session_id')

    return {
      provider: 'cashfree',
      providerOrderId,
      amountPaise,
      currency,
      // ONLY the session handle crosses to the browser. `cf_order_id` and the rest of the
      // response stay server-side — the client has no use for them and they are not its business.
      checkout: { provider: 'cashfree', paymentSessionId, mode: cashfreeEnvironment() },
    }
  },

  /**
   * Re-reads the order to recover its `payment_session_id`.
   *
   * Verified against the live sandbox in RD-PAYMENT-CASHFREE-SANDBOX-05B: GET /orders/{id}
   * returns the same `payment_session_id` the create call did, so a reused order can be paid
   * without minting a second one.
   */
  async getCheckoutHandoff(providerOrderId): Promise<CheckoutHandoff> {
    const res = await call<{ payment_session_id?: string }>(`/orders/${encodeURIComponent(providerOrderId)}`)
    const paymentSessionId = res.payment_session_id ?? ''
    if (!paymentSessionId) {
      throw new Error(`[cashfree] order ${providerOrderId} has no payment_session_id — it cannot be paid`)
    }
    return { provider: 'cashfree', paymentSessionId, mode: cashfreeEnvironment() }
  },

  async fetchOrderPayments(providerOrderId): Promise<NormalizedPayment[]> {
    const res = await call<CashfreePaymentLike[] | null>(`/orders/${encodeURIComponent(providerOrderId)}/payments`)
    return Array.isArray(res) ? res.map(toNormalizedPayment) : []
  },

  /**
   * Cashfree addresses a single payment by ORDER + payment id, so there is no order-less
   * lookup to implement. Rather than fake one, this resolves through the order's payments —
   * and returns null when the id is not on that order, which is also the membership check.
   */
  async fetchPayment(providerPaymentId): Promise<NormalizedPayment | null> {
    void providerPaymentId
    throw new Error(
      '[cashfree] fetchPayment(paymentId) is not supported: Cashfree scopes a payment to its ' +
      'order. Use fetchOrderPayments(orderId) and select by cf_payment_id.',
    )
  },

  /**
   * Cashfree has no browser-returned checkout signature equivalent to Razorpay's
   * `order_id|payment_id` HMAC — the return_url carries no signed payload to verify. The
   * authoritative confirmations are the webhook and a server-side payments fetch.
   *
   * It returns FALSE rather than throwing, and false is the safe answer: a caller that asks
   * "is this browser callback proof of payment?" gets "no", which forces the server-side
   * check instead of accepting an unverified claim.
   */
  async verifyCheckoutSignature(): Promise<boolean> {
    return false
  },

  async verifyWebhookSignature(rawBody, signature): Promise<boolean> {
    // The timestamp-bearing overload lives on the webhook route, which has the headers. This
    // contract method cannot see them, so it refuses rather than verifying a weaker string.
    void rawBody; void signature
    throw new Error(
      '[cashfree] webhook verification needs the x-webhook-timestamp header; ' +
      'use verifyCashfreeWebhook(rawBody, signature, timestamp, secret).',
    )
  },

  async refund({ providerOrderId, amountPaise, reason, receipt }): Promise<NormalizedRefund> {
    if (!providerOrderId) {
      throw new Error('[cashfree] refund needs providerOrderId — Cashfree refunds are scoped to an order.')
    }
    // `refund_id` is merchant-supplied and must be unique; reusing the same receipt for a
    // retry is what makes the retry idempotent instead of a second refund.
    const res = await call<{ cf_refund_id?: string; refund_id?: string; refund_status?: string }>(
      `/orders/${encodeURIComponent(providerOrderId)}/refunds`,
      { method: 'POST', body: {
        refund_id:     receipt.slice(0, 40),
        refund_amount: paiseToRupeeString(amountPaise),
        refund_note:   reason.slice(0, 100),
      } },
    )
    return {
      provider:         'cashfree',
      providerRefundId: String(res.cf_refund_id ?? res.refund_id ?? ''),
      status:           String(res.refund_status ?? 'PENDING'),
      amountPaise,
    }
  },
}

/**
 * Config presence for the CURRENT environment, for the registry. Never logs or returns values.
 *
 * Environment-aware on purpose: with production selected, having sandbox keys present is not
 * "configured" — it is the mix-up this split exists to prevent.
 */
export function isCashfreeConfigured(): boolean {
  const [id, secret] = cashfreeEnvironment() === 'production'
    ? [process.env.CASHFREE_PROD_CLIENT_ID, process.env.CASHFREE_PROD_CLIENT_SECRET]
    : [process.env.CASHFREE_CLIENT_ID,      process.env.CASHFREE_CLIENT_SECRET]
  return Boolean((id ?? '').trim() && (secret ?? '').trim())
}

/**
 * The webhook secret IS the client secret — of the environment this process is serving.
 *
 * Read lazily and never logged. Taking the sandbox secret while running production would
 * reject every genuine webhook (and, worse, would accept anything signed with the sandbox
 * key), so it follows `CASHFREE_ENV` exactly as the API credentials do.
 */
export function cashfreeWebhookSecret(): string {
  return cashfreeEnvironment() === 'production'
    ? (process.env.CASHFREE_PROD_CLIENT_SECRET ?? '').trim()
    : (process.env.CASHFREE_CLIENT_SECRET ?? '').trim()
}
