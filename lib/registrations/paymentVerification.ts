// RD-PAY-P0-2 — how to read the outcome of POST /api/registrations/verify-payment. PURE.
//
// No SDK, no fetch, no React — so every branch below is unit-tested directly, which is the
// only way to assert the double-charge rule without a live gateway.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The attendee has ALREADY paid by the time verify-payment is called: Razorpay's `handler`
// only fires after the gateway has taken the money. So a failed verification does NOT mean
// "the payment failed" — most of the time it means "we could not reach our own server to
// record a payment that already happened".
//
// The old client collapsed every non-success into one message and then re-armed the Pay
// button, which created a second Razorpay order and charged the attendee twice. The whole
// fix rests on splitting that single failure bucket into two with very different rights:
//
//   FINAL     — the server reached a DECISION about this payment. It is settled one way or
//               the other, and RegisterDesk has already refunded anything it refused (see
//               verify-payment's gate / duplicate / capacity / coupon / invite branches).
//               A fresh payment attempt is safe here, because the first one is closed.
//
//   TRANSIENT — the server did not decide. The request timed out, was throttled, blew up,
//               or answered with something that is not our JSON at all. The payment may be
//               captured and simply unrecorded. A fresh order here is the double charge.
//
// The default for anything unrecognised is TRANSIENT. Getting this wrong in the safe
// direction costs a retry; getting it wrong in the unsafe direction costs the attendee
// money, and money is not recoverable by refreshing.

/** What the client is allowed to do next. */
export type VerifyOutcome =
  /** Registration exists. Nothing more to do. */
  | { kind: 'confirmed'; registrationId: string }
  /**
   * The server decided and refused. `error` is its own copy — verify-payment already
   * explains the refund where one was issued. A new payment attempt is permitted.
   */
  | { kind: 'final'; error: string; reason?: string }
  /**
   * Undecided. The payment may exist. The client must poll payment-status and must NOT
   * create another order.
   */
  | { kind: 'transient'; error: string }

export interface VerifyResponseLike {
  success?:        boolean
  registrationId?: string
  error?:          string
  reason?:         string
}

/**
 * HTTP statuses that mean "ask again later", not "this payment is settled".
 *
 * 408 request timeout · 425 too early · 429 throttled · 500/502/503/504 gateway or server.
 * Vercel answers 504 with an HTML body, so those never parse as JSON either — both signals
 * point the same way.
 */
export function isTransientVerifyStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Business decisions verify-payment makes AFTER capture. Every one of these has already
 * triggered a refund server-side (or, for INVALID_SIGNATURE, means no valid payment was
 * ever presented), so the first attempt is closed and retrying cannot double-charge.
 */
const FINAL_REASONS = new Set([
  'INVALID_SIGNATURE',    // 400 — the client's own payload was not signed by Razorpay
  'INTENT_NOT_FOUND',     // 404 — no such order; nothing to settle
  'PAYMENT_REFUNDED',     // 409 — terminal intent guard; already refunded
  'DUPLICATE_EMAIL',      // 409 — refunded
  'DUPLICATE_MOBILE',     // 409 — refunded
  'EVENT_CAPACITY_FULL',  // 409 — refunded
  'PASS_CAPACITY_FULL',   // 409 — refunded
  'PASS_NOT_AVAILABLE',   // 409 — refunded
  'COUPON_EXHAUSTED',     // 409 — refunded
  'INVITE_CODE_INVALID',  // 403 — refunded
  'EVENT_CANCELLED',      // 409 — gate-blocked, refunded
  'REGISTRATION_CLOSED',
  'EVENT_UNAVAILABLE',
  'EVENT_NOT_PUBLISHED',
])

const TRANSIENT_MESSAGE =
  'We are confirming your payment. Do not pay again — if you were charged, your registration will be completed automatically.'

/**
 * Classify one verify-payment attempt.
 *
 * @param threw  the fetch itself rejected (offline, DNS, connection reset, abort) or the
 *               body could not be parsed. Always TRANSIENT — nothing was learned.
 */
export function classifyVerifyOutcome(input: {
  threw?:  boolean
  status?: number
  body?:   VerifyResponseLike | null
}): VerifyOutcome {
  if (input.threw) return { kind: 'transient', error: TRANSIENT_MESSAGE }

  const status = input.status ?? 0
  const body   = input.body ?? null

  // Success is the ONLY path that needs both flags — a 200 without a registrationId has
  // not created anything and must not be treated as done.
  if (status === 200 && body?.success === true && body.registrationId) {
    return { kind: 'confirmed', registrationId: body.registrationId }
  }

  if (isTransientVerifyStatus(status)) return { kind: 'transient', error: TRANSIENT_MESSAGE }

  // A recognised business decision — settled, and already refunded where applicable.
  if (body?.reason && FINAL_REASONS.has(body.reason)) {
    return { kind: 'final', error: body.error ?? 'This payment could not be used to register.', reason: body.reason }
  }

  // 4xx we do not recognise: the server answered deliberately, so it decided, but we do not
  // know what it decided. Treat as FINAL only when it is a client error carrying our own
  // error envelope; anything else falls through to transient.
  if (status >= 400 && status < 500 && body && typeof body.error === 'string') {
    return { kind: 'final', error: body.error, ...(body.reason ? { reason: body.reason } : {}) }
  }

  // Unrecognised shape, 0, opaque, or a 2xx that is not a success envelope.
  return { kind: 'transient', error: TRANSIENT_MESSAGE }
}

/** Retry schedule for TRANSIENT outcomes, in ms. Bounded — never an infinite loop. */
export const VERIFY_RETRY_DELAYS_MS = [1_000, 3_000, 7_000] as const

/** Total attempts = first try + one per delay. */
export const VERIFY_MAX_ATTEMPTS = VERIFY_RETRY_DELAYS_MS.length + 1

// ─── create-order ─────────────────────────────────────────────────────────────
//
// RD-PAY-P0-5. The same split, one step earlier in the flow.
//
// A create-order request that never returns is NOT proof that nothing was created. The
// route creates the Razorpay order (step 8), writes the payment intent (step 9) and claims
// the attempt (step 9b) BEFORE it responds, so a lost response can leave a real order
// behind. Telling that attendee "please try again" is how a second order gets minted.
//
// The split is provable from the route's own control flow rather than guessed. Every 4xx
// create-order can return — 400 body/email/phone/validation/coupon, 401 login, 403 gate and
// invite, 404 event/pass, 409 duplicate, 429 rate limit — is returned BEFORE
// `razorpay.orders.create` is ever called. Only 502 (`razorpay_failed`) and 500
// (`intent_write_failed`) sit at or after it. So:
//
//   4xx  → the server decided, and decided before creating anything → releasing is safe.
//   5xx  → the server may have got as far as an order → UNKNOWN.
//   abort / network reject / unparseable body → nothing was learned → UNKNOWN.
//
// 409 PAYMENT_IN_PROGRESS is deliberately NOT "definite": it is the server telling us a
// captured payment already exists for this attempt, which the caller parks rather than
// releases. It is handled ahead of this classifier and never reaches it.

/** How long to wait for create-order before giving up on the response.
 *
 *  Generous on purpose. The route does a gate check, an event read, a duplicate check,
 *  coupon validation, fee resolution and a live Razorpay `orders.create`, any of which can
 *  be slow on a cold serverless instance — and an aggressive timeout here does not prevent
 *  an order, it just stops us hearing about one. 30s bounds how long an attendee can stare
 *  at the processing lock while still clearing normal p99 latency with room to spare. */
export const CREATE_ORDER_TIMEOUT_MS = 30_000

export type CreateOrderOutcome =
  /** The server answered and refused, before anything was created. Safe to release. */
  | { kind: 'definite'; error: string }
  /** No usable answer. An order MAY exist. Park; never invite another payment. */
  | { kind: 'unknown' }

const UNKNOWN_STATUSES = (status: number) => status >= 500 || status === 0

export function classifyCreateOrderOutcome(input: {
  /** The fetch rejected — abort/timeout, offline, DNS, connection reset. */
  threw?:  boolean
  status?: number
  body?:   { error?: string; reason?: string } | null
}): CreateOrderOutcome {
  if (input.threw) return { kind: 'unknown' }

  const status = input.status ?? 0
  if (UNKNOWN_STATUSES(status)) return { kind: 'unknown' }

  // A 4xx that did not carry our JSON envelope is not something we can act on; treat the
  // missing body as "we could not read the answer" rather than assume it was a refusal.
  const message = input.body?.error
  if (typeof message === 'string' && message.trim()) return { kind: 'definite', error: message }

  return { kind: 'unknown' }
}
